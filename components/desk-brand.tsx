"use client";

import { FileText } from "lucide-react";

export function Brand() {
  return <div className="sd-brand"><span><FileText size={22} aria-hidden="true"/></span>Bill<span>Desk</span></div>;
}

export function ToyotaEmblem() {
  return <svg className="sd-toyota-emblem" viewBox="0 0 64 44" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true"><ellipse cx="32" cy="22" rx="29" ry="19"/><ellipse cx="32" cy="22" rx="10" ry="19"/><ellipse cx="32" cy="13" rx="25" ry="10"/></svg>;
}
