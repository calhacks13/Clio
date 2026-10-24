import type { ReactNode } from "react";

export function InspectionSection({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`inspection-section ${className}`} aria-label={title}>
      <h2 className="inspection-section-heading">{title}</h2>
      {children}
    </section>
  );
}
