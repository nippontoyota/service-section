"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu, X } from 'lucide-react';
import { Brand } from './desk-brand';

export function DeskSidebar({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return <>
    <header className="sd-mobile-header"><Brand/><button aria-label="Open navigation" aria-expanded={open} aria-controls="desk-mobile-navigation" onClick={() => setOpen(true)}><Menu size={24}/></button></header>
    <aside className="sd-sidebar sd-desktop-sidebar">{children}</aside>
    {open && <MobileNavigation onClose={close}>{children}</MobileNavigation>}
  </>;
}

function MobileNavigation({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current, previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    dialog?.showModal(); document.body.style.overflow = 'hidden';
    const desktop = window.matchMedia('(min-width: 761px)');
    const resize = () => { if (desktop.matches) onClose(); };
    desktop.addEventListener('change', resize);
    return () => { desktop.removeEventListener('change', resize); dialog?.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, [onClose]);
  return <dialog ref={ref} id="desk-mobile-navigation" aria-label="Navigation" className="sd-sidebar sd-mobile-drawer" onCancel={e => { e.preventDefault(); onClose(); }} onKeyDown={e => {
    if (e.key !== 'Tab') return;
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }} onClick={e => {
    const target = e.target as HTMLElement;
    const rect = e.currentTarget.getBoundingClientRect();
    if (target.closest('nav button, .sd-sidebar-bottom button') || (target === e.currentTarget && (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom))) onClose();
  }}>
    <button autoFocus className="sd-menu-close" aria-label="Close navigation" onClick={onClose}><X size={22}/></button>
    {children}
  </dialog>;
}
