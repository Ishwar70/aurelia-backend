import type { Staff, StaffRole } from "./types";

const PERMISSIONS: Record<StaffRole, string[]> = {
  super_admin: ["*"],
  catalog_manager: ["catalog.read", "catalog.write"],
  order_operator: ["orders.read", "orders.write", "orders.refund", "customers.read"],
  support: ["orders.read", "customers.read"],
  analyst: ["reports.read"],
};

export function staffCan(staff: Staff, action: string): boolean {
  if (!staff.active) return false;
  const granted = PERMISSIONS[staff.role];
  return granted.includes("*") || granted.includes(action);
}
