import type { Metadata } from "next";
import { AccountClient } from "./AccountClient";

export const metadata: Metadata = { title: "账户" };

export default function AccountPage() {
  return <AccountClient />;
}
