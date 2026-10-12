"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export default function Modal({ open, onOpenChange, title, description, children, className = "" }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: React.ReactNode; className?: string;
}) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal><Dialog.Overlay className="modal-overlay" /><Dialog.Content className={`modal ${className}`}>
      <div className="modal-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon-button" aria-label="Close dialog"><X size={18} /></Dialog.Close></div>
      <Dialog.Description className={description ? "modal-description" : "sr-only"}>{description ?? title}</Dialog.Description>
      {children}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
