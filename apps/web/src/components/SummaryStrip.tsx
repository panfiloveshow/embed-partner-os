import { CheckCircle2, CircleAlert, Clock3, TimerReset } from "lucide-react";
import type { TodaySummary } from "@embed-os/contracts";

export function SummaryStrip({ summary }: { summary: TodaySummary }) {
  const items = [
    { label: "Критично", value: summary.critical, tone: "critical", icon: CircleAlert },
    { label: "На сегодня", value: summary.today, tone: "today", icon: Clock3 },
    { label: "В ожидании", value: summary.waiting, tone: "waiting", icon: TimerReset },
    { label: "Выполнено", value: summary.completed, tone: "done", icon: CheckCircle2 },
  ];

  return (
    <section className="summary-strip" aria-label="Операционный итог">
      {items.map(({ label, value, tone, icon: Icon }) => (
        <div className={`summary-item summary-${tone}`} key={label}>
          <Icon size={25} strokeWidth={1.8} aria-hidden="true" />
          <div>
            <span className="summary-label">{label}</span>
            <strong>{value}</strong>
          </div>
        </div>
      ))}
    </section>
  );
}
