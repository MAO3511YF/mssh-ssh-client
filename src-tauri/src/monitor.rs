//! 远程资源采集：通过 SSH exec 读取 Linux /proc 与常用命令，解析成 MonitorSnapshot。
//! 前端 monitor.ts 原本用随机数据模拟，这里替换为真实采样。
//!
//! 采集策略：一次 exec 拉取所有静态/瞬时信息，CPU 与网络速率用两段采样差值计算。
//! 每个会话维护一个 24 点的历史环形缓冲，供前端画趋势图。

use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::Mutex;

use anyhow::{Context, Result};
use tokio::time::{Duration, sleep};

use crate::model::{FilesystemEntry, GpuInfo, MonitorSnapshot, NetConnection, ProcessEntry};
use crate::ssh;

/// 每条会话的历史曲线（cpu%、net KB/s）
struct History {
    cpu: Vec<f64>,
    net: Vec<f64>,
}
const HISTORY_LEN: usize = 24;
static HISTORY: LazyLock<Mutex<HashMap<String, History>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn push_history(id: &str, cpu: f64, net: f64) -> (Vec<f64>, Vec<f64>) {
    // 锁中毒（此前某次采集 panic）时不能让整个采集跟着崩，退化为空历史
    let Ok(mut map) = HISTORY.lock() else {
        return (Vec::new(), Vec::new());
    };
    let h = map.entry(id.to_string()).or_insert_with(|| History {
        cpu: vec![0.0; HISTORY_LEN],
        net: vec![0.0; HISTORY_LEN],
    });
    if h.cpu.len() >= HISTORY_LEN {
        h.cpu.remove(0);
        h.net.remove(0);
    }
    h.cpu.push(cpu);
    h.net.push(net);
    (h.cpu.clone(), h.net.clone())
}

/// 会话结束时清掉它的历史曲线。
/// sessionId 形如 `${config.id}-${Date.now()}`，每次重连都是新键，
/// 不主动清理的话这个 Map 会随使用时长无限增长。
pub fn forget(id: &str) {
    if let Ok(mut map) = HISTORY.lock() {
        map.remove(id);
    }
}

/// CPU 采样：(user, nice, system, idle, iowait, irq, softirq, steal, guest...)
fn cpu_ticks(stat: &str) -> Option<(u64, u64)> {
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let f: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|x| x.parse().ok())
        .collect();
    if f.len() < 4 {
        return None;
    }
    let idle = f[3] + f.get(4).copied().unwrap_or(0);
    let total: u64 = f.iter().sum();
    Some((total, idle))
}

/// /proc/net/dev：返回 (iface, rx_bytes, tx_bytes)
fn net_bytes(dev: &str) -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
    for line in dev.lines().skip(2) {
        let mut p = line.split_whitespace();
        let iface = match p.next() {
            Some(s) => s.trim_end_matches(':').to_string(),
            None => continue,
        };
        if iface == "lo" {
            continue;
        }
        let nums: Vec<u64> = p.filter_map(|x| x.parse().ok()).collect();
        // 格式：rx bytes packets ... tx bytes packets ...
        if nums.len() >= 9 {
            out.insert(iface, (nums[0], nums[8]));
        }
    }
    out
}

fn parse_mem_line(line: &str, parts: &mut std::collections::HashMap<String, f64>) {
    if let Some((k, v)) = line.split_once(':') {
        let kb = v
            .split_whitespace()
            .next()
            .and_then(|x| x.parse::<f64>().ok())
            .unwrap_or(0.0);
        // /proc/meminfo 单位是 kB，前端按 GiB 展示，需除 1024*1024
        parts.insert(k.trim().to_string(), kb / 1024.0 / 1024.0);
    }
}

fn format_uptime(secs: f64) -> String {
    let s = secs as u64;
    let d = s / 86400;
    let h = (s % 86400) / 3600;
    let m = (s % 3600) / 60;
    if d > 0 {
        format!("{}d {}h", d, h)
    } else {
        format!("{}h {}m", h, m)
    }
}

/// 解析 nvidia-smi 的 CSV 输出为真实 GPU 信息。
/// 查询顺序：name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw
/// 任一数值字段解析不出就返回 None——宁可整块隐藏，也不能显示假值。
/// 温度/功耗允许缺失（部分驱动不报），用 None 表示并在 UI 省略该行。
fn parse_gpu(output: &str) -> Option<GpuInfo> {
    let line = output.lines().find(|l| !l.trim().is_empty())?.trim();
    let f: Vec<&str> = line.split(',').map(|x| x.trim()).collect();
    if f.len() < 4 {
        return None;
    }
    let name = f[0];
    if name.is_empty() || name == "N/A" {
        return None;
    }
    let num = |s: &str| -> Option<f64> {
        let s = s.split_whitespace().next().unwrap_or("");
        if s.is_empty() || s == "[N/A]" || s == "N/A" { None } else { s.parse::<f64>().ok() }
    };
    let utilization = num(f.get(1).copied().unwrap_or(""))?;
    let mem_used = num(f.get(2).copied().unwrap_or(""))?;
    let mem_total = num(f.get(3).copied().unwrap_or(""))?;
    let temperature = f.get(4).and_then(|s| num(s));
    let power = f.get(5).and_then(|s| num(s)).map(|w| {
        // nvidia-smi 的 power.draw 单位固定是 W，但旧版可能带 "W" 后缀已被 num 去掉
        w
    });
    Some(GpuInfo {
        name: name.to_string(),
        utilization: utilization.min(100.0).max(0.0),
        mem_used,
        mem_total,
        temperature,
        power,
    })
}

/// 采集一次完整快照
pub async fn collect(session_id: &str) -> Result<MonitorSnapshot> {
    // 保留一位小数的统一取整函数
    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    // 一次拉取所有需要的静态信息；用 ';' 分隔避免 && 因某条命令失败中断
    let cmd = concat!(
        "echo __UPTIME__; cat /proc/uptime 2>/dev/null; ",
        "echo __LOAD__; cat /proc/loadavg 2>/dev/null; ",
        "echo __CPUINFO__; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo; ",
        "echo __STAT__; cat /proc/stat 2>/dev/null; ",
        "echo __MEM__; cat /proc/meminfo 2>/dev/null; ",
        "echo __DF__; df -kP 2>/dev/null; ",
        "echo __NETDEV__; cat /proc/net/dev 2>/dev/null; ",
        // 用 netstat 统一格式（ss 的输出列布局不同，旧代码按 netstat 解析 ss 会全部落空）
        "echo __NETSTAT__; (netstat -tan 2>/dev/null || ss -tan 2>/dev/null); ",
        // 关键：ps 的 PID 列右对齐带前导空格，解析侧必须用 split_whitespace 而非 splitn
        "echo __PS__; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -40; ",
        "echo __DISKSTATS__; cat /proc/diskstats 2>/dev/null | head -40; ",
        // GPU：仅在装有 nvidia-smi 且有显卡时才有输出；无 GPU 的机器整段为空
        "echo __GPU__; nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null; ",
        "echo __END__"
    );

    let raw = ssh::exec_capture(session_id, cmd)
        .await
        .with_context(|| "采集远程系统信息失败")?;

    // 分段
    let mut sections: HashMap<&str, String> = HashMap::new();
    let mut current: &str = "";
    let mut buf = String::new();
    for line in raw.lines() {
        if let Some(key) = line.strip_prefix("__") {
            if let Some(key) = key.strip_suffix("__") {
                if !current.is_empty() {
                    sections.insert(current, std::mem::take(&mut buf));
                }
                current = match key {
                    "UPTIME" => "UPTIME",
                    "LOAD" => "LOAD",
                    "CPUINFO" => "CPUINFO",
                    "STAT" => "STAT",
                    "MEM" => "MEM",
                    "DF" => "DF",
                    "NETDEV" => "NETDEV",
                    "NETSTAT" => "NETSTAT",
                    "PS" => "PS",
                    "DISKSTATS" => "DISKSTATS",
                    "GPU" => "GPU",
                    "END" => "END",
                    _ => current,
                };
                continue;
            }
        }
        if !current.is_empty() {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if !current.is_empty() {
        sections.insert(current, buf);
    }

    // ---- 运行时长 / 负载 ----
    let uptime = sections
        .get("UPTIME")
        .and_then(|s| s.split_whitespace().next())
        .and_then(|x| x.parse::<f64>().ok())
        .map(format_uptime)
        .unwrap_or_else(|| "—".into());
    let load = sections
        .get("LOAD")
        .and_then(|s| {
            let f: Vec<f64> = s.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
            if f.len() == 3 { Some([f[0], f[1], f[2]]) } else { None }
        })
        .unwrap_or([0.0, 0.0, 0.0]);

    // ---- CPU 核数 ----
    let cpu_cores = sections
        .get("CPUINFO")
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1);

    // ---- CPU / 网络 / 磁盘 IO 使用率：再采一次算差值 ----
    let stat1 = sections.get("STAT").cloned().unwrap_or_default();
    let net1 = sections.get("NETDEV").cloned().unwrap_or_default();
    let disk1 = sections.get("DISKSTATS").cloned().unwrap_or_default();
    sleep(Duration::from_millis(400)).await;
    // 一次 exec 取回三项，减少子通道往返（分开取会叠加 3 次 RTT）
    let second = ssh::exec_capture(
        session_id,
        "echo __STAT__; cat /proc/stat 2>/dev/null; echo __NETDEV__; cat /proc/net/dev 2>/dev/null; echo __DISK__; cat /proc/diskstats 2>/dev/null",
    ).await.unwrap_or_default();
    let (stat2, net2, disk2) = split_second_sample(&second);

    let cpu_pct = match (cpu_ticks(&stat1), cpu_ticks(&stat2)) {
        (Some((t1, i1)), Some((t2, i2))) if t2 > t1 => {
            let total_d = t2 - t1;
            let idle_d = i2.saturating_sub(i1);
            // /proc/stat 的 "cpu " 行是所有核的合计 ticks，(busy/total) 已是整体利用率，
            // 直接 ×100 归一到 0-100% 即可。此前再乘 cpu_cores 会让 8 核机器上任意一个核
            // 忙 25% 就被 clamp 成 100%，完全失真。
            ((total_d.saturating_sub(idle_d)) as f64 / total_d as f64 * 100.0).min(100.0)
        }
        _ => 0.0,
    };

    // ---- 网络速率 KB/s ----
    let m1 = net_bytes(&net1);
    let m2 = net_bytes(&net2);
    let mut rx_total = 0.0;
    let mut tx_total = 0.0;
    for (iface, (r1, t1)) in &m1 {
        if let Some((r2, t2)) = m2.get(iface) {
            if *r2 >= *r1 {
                rx_total += (*r2 - *r1) as f64 / 1024.0 / 0.4;
            }
            if *t2 >= *t1 {
                tx_total += (*t2 - *t1) as f64 / 1024.0 / 0.4;
            }
        }
    }

    // ---- 磁盘 IO 速率 KB/s：两次 diskstats 扇区差值 × 512B / 采样间隔 ----
    let (read_sec1, write_sec1) = disk_sectors(&disk1);
    let (read_sec2, write_sec2) = disk_sectors(&disk2);
    let interval = 0.4;
    let disk_read = r1((read_sec2.saturating_sub(read_sec1)) as f64 * 512.0 / 1024.0 / interval);
    let disk_write = r1((write_sec2.saturating_sub(write_sec1)) as f64 * 512.0 / 1024.0 / interval);

    // ---- 内存 / Swap ----
    let mut mem = std::collections::HashMap::new();
    for line in sections.get("MEM").unwrap_or(&String::new()).lines() {
        parse_mem_line(line, &mut mem);
    }
    let mem_total_b = mem.get("MemTotal").copied().unwrap_or(0.0);
    let mem_avail_b = mem.get("MemAvailable").copied().unwrap_or(0.0);
    let _mem_free_b = mem.get("MemFree").copied().unwrap_or(0.0);
    let buffers_b = mem.get("Buffers").copied().unwrap_or(0.0);
    let cached_b = mem.get("Cached").copied().unwrap_or(0.0);
    let sreclaim_b = mem.get("SReclaimable").copied().unwrap_or(0.0);
    let mem_cache_b = cached_b + buffers_b + sreclaim_b;
    let mem_used_b = (mem_total_b - mem_avail_b).max(0.0);
    let mem_app_b = (mem_used_b - mem_cache_b).max(0.0);
    let swap_total_b = mem.get("SwapTotal").copied().unwrap_or(0.0);
    let swap_free_b = mem.get("SwapFree").copied().unwrap_or(0.0);
    let swap_used_b = (swap_total_b - swap_free_b).max(0.0);

    // ---- 文件系统（过滤 tmpfs/devtmpfs 等虚拟文件系统）----
    let mut filesystems = Vec::new();
    for line in sections.get("DF").unwrap_or(&String::new()).lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 6 {
            continue;
        }
        let fs = f[0];
        if fs.contains("tmpfs") || fs.contains("devtmpfs") || fs.contains("squashfs") || fs == "udev" {
            continue;
        }
        let total = f[1].parse::<u64>().unwrap_or(0) / 1024 / 1024;
        let used = f[2].parse::<u64>().unwrap_or(0) / 1024 / 1024;
        if total > 0 {
            filesystems.push(FilesystemEntry {
                mount: f[5].to_string(),
                used: used as f64,
                total: total as f64,
            });
        }
    }
    // 不再伪造 "/" 0/1G：采集不到就是空列表，前端据此隐藏磁盘卡片，绝不显示假数据。
    let gpu = sections.get("GPU").and_then(|s| parse_gpu(s));

    // ---- 进程 TOP ----
    // ps 的 PID/%CPU/%MEM 列是右对齐、带前导空格的，必须用 split_whitespace
    // 先拆成完整字段表再按索引取；不能用 splitn(5)——前导空串会占掉段数导致字段错位。
    let mut processes = Vec::new();
    for line in sections.get("PS").unwrap_or(&String::new()).lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 5 {
            continue;
        }
        processes.push(ProcessEntry {
            pid: f[0].parse().unwrap_or(0),
            user: f[1].to_string(),
            cpu: f[2].parse().unwrap_or(0.0),
            mem: f[3].parse().unwrap_or(0.0),
            // 第 5 段起是命令名，可能含空格，全部拼回来
            command: f[4..].join(" "),
        });
    }
    processes.truncate(8);

    // ---- 网络连接 ----
    let mut connections = Vec::new();
    let empty_str = String::new();
    let netstat_raw = sections.get("NETSTAT").unwrap_or(&empty_str);
    // 自动识别 netstat 还是 ss：netstat 表头含 "Proto"，ss 表头含 "State"
    let is_ss = netstat_raw.lines().next().map(|l| l.trim_start().starts_with("State")).unwrap_or(false);
    for line in netstat_raw.lines().skip(if is_ss { 1 } else { 2 }) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if is_ss {
            // ss -tan: State Recv-Q Send-Q Local:Port Peer:Port [Process]
            if f.len() < 4 { continue; }
            let state = f[0];
            if !matches!(state, "LISTEN" | "ESTAB" | "TIME-WAIT" | "CLOSE-WAIT" | "SYN-SENT" | "SYN-RECV" | "FIN-WAIT-1" | "FIN-WAIT-2" | "LAST-ACK" | "CLOSING") {
                continue;
            }
            connections.push(NetConnection {
                proto: if f[2].contains(':') && f[2].chars().filter(|&c| c == ':').count() > 1 { "tcp6" } else { "tcp" }.to_string(),
                local: f[2].to_string(),
                remote: f[3].to_string(),
                state: state.to_string(),
            });
        } else {
            // netstat -tan: Proto Recv-Q Send-Q Local Foreign State
            if f.len() < 6 { continue; }
            if !f[0].starts_with("tcp") { continue; }
            connections.push(NetConnection {
                proto: f[0].to_string(),
                local: f[3].to_string(),
                remote: f[4].to_string(),
                state: f[5].to_string(),
            });
        }
        if connections.len() >= 12 {
            break;
        }
    }

    let (history, net_history) = push_history(session_id, cpu_pct, rx_total + tx_total);

    Ok(MonitorSnapshot {
        session_id: session_id.to_string(),
        uptime,
        load,
        cpu: r1(cpu_pct),
        cpu_cores,
        mem_used: r1(mem_used_b),
        mem_total: r1(mem_total_b),
        mem_app: r1(mem_app_b),
        mem_cache: r1(mem_cache_b),
        swap_used: r1(swap_used_b),
        swap_total: r1(swap_total_b),
        filesystems,
        gpu,
        disk_read,
        disk_write,
        net_in: r1(rx_total),
        net_out: r1(tx_total),
        processes,
        connections,
        history,
        net_history,
    })
}

/// 拆分第二次采样的三段输出（STAT / NETDEV / DISK）
fn split_second_sample(raw: &str) -> (String, String, String) {
    let mut stat = String::new();
    let mut net = String::new();
    let mut disk = String::new();
    let mut cur = "";
    for line in raw.lines() {
        match line.trim() {
            "__STAT__" => { cur = "stat"; continue; }
            "__NETDEV__" => { cur = "net"; continue; }
            "__DISK__" => { cur = "disk"; continue; }
            _ => {}
        }
        match cur {
            "stat" => { stat.push_str(line); stat.push('\n'); }
            "net" => { net.push_str(line); net.push('\n'); }
            "disk" => { disk.push_str(line); disk.push('\n'); }
            _ => {}
        }
    }
    (stat, net, disk)
}

/// 判断 /proc/diskstats 中的设备名是否为"整盘"（应纳入 IO 汇总），
/// 而非分区 / 回环 / 内存盘（跳过，避免与整盘重复计数）。
///
/// 修正：旧逻辑用"名字以数字结尾"判断分区，会把 NVMe 整盘（nvme0n1）、
/// MMC 整盘（mmcblk0）、device-mapper（dm-0）误判为分区跳过，导致这些机型磁盘 IO 恒 0。
/// 现按各类设备命名规则精确区分：
/// - sd/vd/xvd/hd：整盘以字母结尾（sda、vda），分区以数字结尾（sda1、vda1）
/// - nvme：整盘 nvme0n1，分区多一个 p<数字> 后缀（nvme0n1p1）
/// - mmcblk：整盘 mmcblk0，分区多一个 p<数字> 后缀（mmcblk0p1）
/// - dm-/md 等软件设备：承载真实 IO，纳入统计
fn is_whole_disk(name: &str) -> bool {
    // 回环 / 内存盘 / 光驱 / 软驱：非真实存储设备
    if name.starts_with("loop")
        || name.starts_with("ram")
        || name.starts_with("sr")
        || name.starts_with("fd")
    {
        return false;
    }

    // NVMe：nvme0n1 整盘；nvme0n1p1 分区（尾部多一个 p 段）
    if let Some(rest) = name.strip_prefix("nvme") {
        return match rest.rsplit_once('n') {
            Some((_, tail)) => !tail.contains('p'),
            None => false,
        };
    }

    // MMC/SD：mmcblk0 整盘；mmcblk0p1 分区（尾部多一个 p 段）
    if let Some(rest) = name.strip_prefix("mmcblk") {
        return !rest.contains('p');
    }

    // SCSI / virtio / IDE：字母结尾是整盘，数字结尾是分区
    if name.starts_with("sd")
        || name.starts_with("vd")
        || name.starts_with("xvd")
        || name.starts_with("hd")
    {
        return name.chars().last().map(|c| c.is_ascii_lowercase()).unwrap_or(false);
    }

    // dm-* / md* 等其他块设备：纳入（旧逻辑按数字结尾会误跳过 dm-0）
    true
}

/// 从 /proc/diskstats 汇总整机读/写扇区数（累计值）。
/// 字段：major minor name rd_ios rd_merges rd_sectors rd_ticks wr_ios wr_merges wr_sectors ...
/// f[5]=读扇区, f[9]=写扇区；扇区×512B。只统计整盘，跳过分区/回环等避免重复计数。
fn disk_sectors(s: &str) -> (u64, u64) {
    let mut read = 0u64;
    let mut write = 0u64;
    for line in s.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 10 {
            continue;
        }
        if !is_whole_disk(f[2]) {
            continue;
        }
        read += f[5].parse::<u64>().unwrap_or(0);
        write += f[9].parse::<u64>().unwrap_or(0);
    }
    (read, write)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cpu_ticks() {
        let stat = "cpu  100 20 30 850 5 0 0 0 0 0\ncpu0 50 10 15 425 2 0 0 0 0 0\n";
        let (total, idle) = cpu_ticks(stat).unwrap();
        assert_eq!(total, 1005);
        assert_eq!(idle, 855);
    }

    #[test]
    fn parse_net_dev() {
        let dev = "Inter-|   Receive                                                |  Transmit\n \
                    face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n \
                    eth0: 1048576 1000 0 0 0 0 0 0 2097152 900 0 0 0 0 0 0\n \
                    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n";
        let m = net_bytes(dev);
        assert_eq!(m.get("eth0"), Some(&(1048576, 2097152)));
        assert!(!m.contains_key("lo"));
    }

    #[test]
    fn parse_meminfo_gb() {
        let mut parts = std::collections::HashMap::new();
        for line in "MemTotal:     8000000 kB\nMemAvailable: 2000000 kB\nCached:       1000000 kB\n".lines() {
            parse_mem_line(line, &mut parts);
        }
        assert!((parts["MemTotal"] - 7.6294).abs() < 0.01);
        assert!((parts["MemAvailable"] - 1.9073).abs() < 0.01);
    }

    #[test]
    fn uptime_format() {
        assert_eq!(format_uptime(90061.0), "1d 1h");
        assert_eq!(format_uptime(3661.0), "1h 1m");
    }

    /// 回归测试：ps PID 列右对齐带前导空格，旧 splitn(5) 会解析错位导致进程为空
    #[test]
    fn parse_ps_right_aligned() {
        let raw = "    PID USER     %CPU %MEM COMMAND\n   1582523 root      1.6  0.5 sshd\n   1181802 ubuntu    0.9  0.7 barad_agent\n";
        let mut count = 0;
        for line in raw.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            assert!(f.len() >= 5, "字段数不足: {:?}", f);
            assert!(f[0].parse::<u32>().is_ok());
            count += 1;
        }
        assert_eq!(count, 2);
    }

    #[test]
    fn parse_disk_sectors() {
        // 整盘 sda + 分区 sda1 + loop，只应统计 sda 的 f[5]/f[9]
        let s = "   8       0 sda 100 200 1000 300 400 500 2000 600 0 0 0 0\n\
                   8       1 sda1 10 20 100 30 40 50 200 60 0 0 0 0\n\
                   7       0 loop0 1 2 3 4 5 6 7 8 0 0 0 0\n";
        assert_eq!(disk_sectors(s), (1000, 2000));
    }

    /// 回归测试：NVMe 整盘 nvme0n1 / MMC 整盘 mmcblk0 曾被"数字结尾"误判为分区跳过，
    /// 导致这类机型磁盘 IO 恒 0；分区（nvme0n1p1 / mmcblk0p1）仍须跳过。
    #[test]
    fn disk_sectors_nvme_and_mmc_whole_disks() {
        let s = concat!(
            " 259   0 nvme0n1 100 200 1000 300 400 500 2000 600 0 0 0 0\n",
            " 259   1 nvme0n1p1 10 20 100 30 40 50 200 60 0 0 0 0\n",
            " 179   0 mmcblk0 50 60 500 70 80 90 900 100 0 0 0 0\n",
            " 179   1 mmcblk0p1 5 6 50 7 8 9 90 10 0 0 0 0\n",
        );
        // 只累加两块整盘：读 1000+500=1500，写 2000+900=2900
        assert_eq!(disk_sectors(s), (1500, 2900));
    }

    #[test]
    fn whole_disk_name_classification() {
        for name in ["sda", "sdb", "vda", "xvda", "hda", "nvme0n1", "nvme1n2", "mmcblk0", "dm-0", "md0"] {
            assert!(is_whole_disk(name), "{} 应识别为整盘", name);
        }
        for name in ["sda1", "vda1", "nvme0n1p1", "mmcblk0p1", "loop0", "ram0", "sr0", "fd0"] {
            assert!(!is_whole_disk(name), "{} 应跳过", name);
        }
    }

    #[test]
    fn split_second_sample_sections() {
        let raw = "__STAT__\ncpu 1 2 3 4\n__NETDEV__\neth0: 1 2 3\n__DISK__\n8 0 sda 1 2 3 4 5 6 7 8\n";
        let (stat, net, disk) = split_second_sample(raw);
        assert!(stat.contains("cpu 1 2 3 4"));
        assert!(net.contains("eth0:"));
        assert!(disk.contains("sda"));
        assert!(!stat.contains("eth0:"));
    }

    #[test]
    fn parse_gpu_real_and_missing() {
        // 有 GPU：完整六个字段
        let g = parse_gpu("NVIDIA GeForce RTX 3080, 36, 5734, 10240, 48, 74.21\n").expect("应解析出 GPU");
        assert_eq!(g.name, "NVIDIA GeForce RTX 3080");
        assert_eq!(g.utilization, 36.0);
        assert_eq!(g.mem_used, 5734.0);
        assert_eq!(g.mem_total, 10240.0);
        assert_eq!(g.temperature, Some(48.0));
        assert_eq!(g.power, Some(74.21));

        // 温度/功耗为 N/A：允许缺失，但其余字段仍有效
        let g2 = parse_gpu("NVIDIA A100, 12, 100, 40960, [N/A], [N/A]").expect("应解析出 GPU");
        assert_eq!(g2.temperature, None);
        assert_eq!(g2.power, None);

        // 无 GPU：nvidia-smi 不存在时整段为空，必须返回 None（而不是编造数据）
        assert!(parse_gpu("").is_none());
        assert!(parse_gpu("N/A").is_none());
        assert!(parse_gpu("garbage, x, y").is_none());
    }
}
