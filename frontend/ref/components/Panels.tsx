"use client";

import { useState, type ReactNode } from "react";

export interface PanelDef { id: string; label: string; hint: string; content: ReactNode }

/** Press a chip to open its panel. Press it again to close. One panel at a time. */
export function Panels({ panels }: { panels: PanelDef[] }) {
  // The first panel is open by default, so the tab bar never shows an empty page.
  const [open, setOpen] = useState<string | null>(panels[0]?.id ?? null);
  const active = panels.find((p) => p.id === open) ?? null;

  return (
    <div className="panels">
      <div className="chips" role="toolbar" aria-label="Tree information">
        {panels.map((p) => (
          <button
            key={p.id}
            type="button"
            id={`chip-${p.id}`}
            className="chip"
            aria-expanded={open === p.id}
            aria-controls={`panel-${p.id}`}
            onClick={() => setOpen(open === p.id ? null : p.id)}
          >
            <span className="chip-label">{p.label}</span>
            <span className="chip-hint">{p.hint}</span>
          </button>
        ))}
      </div>
      {active && (
        <section id={`panel-${active.id}`} className="panel" aria-labelledby={`chip-${active.id}`}>
          {active.content}
        </section>
      )}
    </div>
  );
}
