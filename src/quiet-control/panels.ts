import type { ComponentType } from "react";
import type { ControlData } from "./data";

/** Compile-time trusted panels only. No discovery, dynamic code, privileged API,
 * or plugin permissions. Future in-repo modules can consume the same snapshot. */
export interface HomePanel {
  id: string;
  Component: ComponentType<{ data: ControlData }>;
}
export const homePanels: readonly HomePanel[] = [];
