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

use crate::model::{FilesystemEntry, MonitorSnapshot, NetConnection, ProcessEntry};
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

/// 采集一次完整快照
pub async fn collect(session_id: &str) -> Result<MonitorSnapshot> {
    // 一次拉取所有需要的静态信息；用 ';' 分隔避免 && 因某条命令失败中断
    let cmd = concat!(
        "echo __UPTIME__; cat /proc/uptime 2>/dev/null; ",
        "echo __LOAD__; cat /proc/loadavg 2>/dev/null; ",
        "echo __CPUINFO__; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo; ",
        "echo __STAT__; cat /proc/stat 2>/dev/null; ",
        "echo __MEM__; cat /proc/meminfo 2>/dev/null; ",
        "echo __DF__; df -kP 2>/dev/null; ",
        "echo __NETDEV__; cat /proc/net/dev 2>/dev/null; ",
        "echo __NETSTAT__; (ss -tan 2>/dev/null || netstat -tan 2>/dev/null); ",
        "echo __PS__; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -40; ",
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

    // ---- CPU 使用率：再采一次 /proc/stat 算差值 ----
    let stat1 = sections.get("STAT").cloned().unwrap_or_default();
    let net1 = sections.get("NETDEV").cloned().unwrap_or_default();
    sleep(Duration::from_millis(400)).await;
    let stat2 = ssh::exec_capture(session_id, "cat /proc/stat 2>/dev/null").await.unwrap_or_default();
    let net2 = ssh::exec_capture(session_id, "cat /proc/net/dev 2>/dev/null").await.unwrap_or_default();

    let cpu_pct = match (cpu_ticks(&stat1), cpu_ticks(&stat2)) {
        (Some((t1, i1)), Some((t2, i2))) if t2 > t1 => {
            let total_d = t2 - t1;
            let idle_d = i2.saturating_sub(i1);
            ((total_d - idle_d) as f64 / total_d as f64 * 100.0 * cpu_cores as f64).min(100.0)
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
    let r1 = |v: f64| (v * 10.0).round() / 10.0;

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
    if filesystems.is_empty() {
        filesystems.push(FilesystemEntry { mount: "/".into(), used: 0.0, total: 1.0 });
    }

    // ---- 进程 TOP ----
    let mut processes = Vec::new();
    for line in sections.get("PS").unwrap_or(&String::new()).lines().skip(1) {
        let f: Vec<&str> = line.splitn(5, char::is_whitespace).filter(|x| !x.is_empty()).collect();
        if f.len() < 5 {
            continue;
        }
        processes.push(ProcessEntry {
            pid: f[0].parse().unwrap_or(0),
            user: f[1].to_string(),
            cpu: f[2].parse().unwrap_or(0.0),
            mem: f[3].parse().unwrap_or(0.0),
            command: f[4].to_string(),
        });
    }
    processes.truncate(8);

    // ---- 网络连接 ----
    let mut connections = Vec::new();
    for line in sections.get("NETSTAT").unwrap_or(&String::new()).lines().skip(2) {
        let f: Vec<&str> = line.split_whitespace().collect();
        // 后面要取 f[3]/f[4]/f[5]，少于 6 个字段的行直接跳过，
        // 否则一行残缺输出就会 panic
        if f.len() < 6 {
            continue;
        }
        if !f[0].starts_with("tcp") {
            continue;
        }
        connections.push(NetConnection {
            proto: f[0].to_string(),
            local: f[3].to_string(),
            remote: f[4].to_string(),
            state: f[5].to_string(),
        });
        if connections.len() >= 12 {
            break;
        }
    }

    // ---- 磁盘 IO：从 /proc/diskstats 累计值简化读取（KB 累计，趋势参考）----
    let disk_stat = ssh::exec_capture(session_id, "cat /proc/diskstats 2>/dev/null | head -30")
        .await
        .unwrap_or_default();
    let (disk_read, disk_write) = parse_diskstats(&disk_stat);

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

fn parse_diskstats(s: &str) -> (f64, f64) {
    // 字段：major minor name rd_ios rd_merges rd_sectors rd_ticks wr_ios ... wr_sectors ...
    // sector = 512B，这里给出累计 KB（前端用作参考）
    let mut read_kb = 0u64;
    let mut write_kb = 0u64;
    for line in s.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        // 用到 f[5] 与 f[9]，至少需要 10 个字段（标准 /proc/diskstats 是 14 个）
        if f.len() < 10 {
            continue;
        }
        let name = f[2];
        // 跳过分区与回环/ram 设备，只统计整盘
        if name.starts_with("loop") || name.starts_with("ram") || name.ends_with(char::is_numeric) && f.len() > 3 {
            // 分区通常形如 sda1；整盘 sda。用末位是否数字粗判
            if name.chars().last().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                continue;
            }
        }
        read_kb += f[5].parse::<u64>().unwrap_or(0) / 2;
        write_kb += f[9].parse::<u64>().unwrap_or(0) / 2;
    }
    (read_kb as f64 / 1024.0, write_kb as f64 / 1024.0)
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
}
