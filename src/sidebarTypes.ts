import type { SessionConfig } from "./types";

export interface DirectoryGroup {
  name: string;
  items: SessionConfig[];
  empty: boolean;
}
