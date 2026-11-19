import type { Driver } from "../types";
import { MockDriver } from "./mock";
import { TauriDriver } from "./tauri";

/** 在 Tauri 环境用原生驱动，否则降级到浏览器 Mock。 */
function detect(): Driver {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  return w.__TAURI_INTERNALS__ ? new TauriDriver() : new MockDriver();
}

export const driver: Driver = detect();
