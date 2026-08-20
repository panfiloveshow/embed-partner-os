import { useState } from "react";
import { Clock3, ShieldCheck } from "lucide-react";
import { AccessManagementPage } from "./AccessManagementPage";
import { SlaSettingsPage } from "./SlaSettingsPage";

interface SettingsPageProps {
  teamName: string;
}

export function SettingsPage({ teamName }: SettingsPageProps) {
  const [section, setSection] = useState<"sla" | "access">("sla");
  return (
    <div className="settings-page-shell">
      <nav className="settings-tabs" aria-label="Раздел настроек">
        <button
          type="button"
          className={section === "sla" ? "settings-tab settings-tab-active" : "settings-tab"}
          onClick={() => setSection("sla")}
          aria-current={section === "sla" ? "page" : undefined}
        >
          <Clock3 size={16} aria-hidden="true" />
          SLA и эскалации
        </button>
        <button
          type="button"
          className={section === "access" ? "settings-tab settings-tab-active" : "settings-tab"}
          onClick={() => setSection("access")}
          aria-current={section === "access" ? "page" : undefined}
        >
          <ShieldCheck size={16} aria-hidden="true" />
          Роли и доступ
        </button>
      </nav>
      {section === "sla" ? (
        <SlaSettingsPage teamName={teamName} />
      ) : (
        <AccessManagementPage teamName={teamName} />
      )}
    </div>
  );
}
