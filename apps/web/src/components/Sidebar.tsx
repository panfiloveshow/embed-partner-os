import { useState } from "react";
import {
  BarChart3,
  Building2,
  ClipboardCheck,
  Filter,
  Home,
  LogOut,
  Menu,
  Radar,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ActorPermission, ActorRole, SessionPayload } from "@embed-os/contracts";

export type AppPage = "today" | "partners" | "funnel" | "radar" | "placements" | "reports" | "settings";

const navigation = [
  { id: "today" as const, label: "Сегодня", icon: Home, permission: "today.read" as const },
  { id: "partners" as const, label: "Партнёры", icon: Building2, permission: "partners.read" as const },
  { id: "funnel" as const, label: "Воронка", icon: Filter, permission: "opportunities.read" as const },
  { id: "radar" as const, label: "Радар", icon: Radar, permission: "radar.read" as const },
  { id: "placements" as const, label: "Размещения", icon: ClipboardCheck, permission: "placements.read" as const },
  { id: "reports" as const, label: "Отчёты", icon: BarChart3, permission: "reports.view" as const },
  { id: "settings" as const, label: "Настройки", icon: Settings, permission: "system.admin" as const },
];

const roleLabels: Record<ActorRole, string> = {
  partner_manager: "Менеджер",
  team_lead: "Руководитель",
  technical_specialist: "Технический специалист",
  analyst: "Аналитик",
  legal: "Юрист",
  admin: "Администратор",
  observer: "Наблюдатель",
};

const scopeLabels: Record<SessionPayload["scope"]["mode"], string> = {
  own: "свои данные",
  assigned: "назначенные данные",
  team: "данные команды",
  all: "все данные",
};

interface SidebarProps {
  session: SessionPayload;
  activePage: AppPage;
  onNavigate: (page: AppPage) => void;
  onLogout?: () => Promise<void>;
}

export function Sidebar({ session, activePage, onNavigate, onLogout }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeLabel = navigation.find(({ id }) => id === activePage)?.label ?? "Embed Partner OS";
  const can = (permission: ActorPermission) =>
    session.role === "admin" || session.permissions.includes(permission);
  const accessLabel = `${roleLabels[session.role]} · ${scopeLabels[session.scope.mode]}`;
  return (
    <aside className={mobileOpen ? "sidebar sidebar-mobile-open" : "sidebar"} aria-label="Основная навигация">
      <div className="brand-block">
        <div className="rutube-wordmark">
          RUTUBE<span aria-hidden="true">●</span>
        </div>
        <div className="product-name">Embed Partner OS</div>
        <strong className="mobile-page-title">{activeLabel}</strong>
        <button
          className="mobile-menu-button"
          type="button"
          onClick={() => setMobileOpen((current) => !current)}
          aria-expanded={mobileOpen}
          aria-label={mobileOpen ? "Закрыть меню" : "Открыть меню"}
        >
          {mobileOpen ? <X size={24} aria-hidden="true" /> : <Menu size={25} aria-hidden="true" />}
        </button>
      </div>

      <nav className="nav-list">
        {navigation.filter(({ permission }) => can(permission)).map(({ id, label, icon: Icon }) => {
          const active = id === activePage;
          return (
          <button
            className={active ? "nav-item nav-item-active" : "nav-item"}
            type="button"
            key={label}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (id) onNavigate(id);
              setMobileOpen(false);
            }}
          >
            <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
            <span>{label}</span>
          </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="user-block">
          <span className="avatar" title={`${session.displayName} · ${accessLabel}`}>
            {session.initials}
          </span>
          <span className="user-identity">
            <span className="user-name">{session.displayName}</span>
            <small className="user-role">{accessLabel}</small>
          </span>
          {onLogout ? (
            <button
              className="sidebar-logout"
              type="button"
              onClick={() => void onLogout()}
              aria-label="Выйти из корпоративной сессии"
              title="Выйти"
            >
              <LogOut size={16} aria-hidden="true" />
            </button>
          ) : (
            <ShieldCheck size={16} aria-label="Права проверены сервером" />
          )}
        </div>
      </div>
    </aside>
  );
}
