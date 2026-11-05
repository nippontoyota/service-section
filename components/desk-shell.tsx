import "./service-desk.css";
export function DeskShell({ children }: { children?: React.ReactNode }) {
  return <div className="sd-app" aria-busy={!children}><aside className="sd-sidebar"><div className="sd-brand">Bill<span>Desk</span></div><div className="sd-placeholder" /></aside><main className="sd-main"><div className="sd-header"><h1>Service workspace</h1></div>{children || <><div className="sd-placeholder"/><div className="sd-placeholder sd-placeholder-large"/></>}</main></div>;
}
