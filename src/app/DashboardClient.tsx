"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { signOutAction } from "./login/actions";
import { workspaceRoleLabels, type WorkspaceRole } from "@/lib/auth/roles";

type IconName =
  | "activity"
  | "alert"
  | "arrow-down"
  | "arrow-up-right"
  | "bot"
  | "check"
  | "chevron-down"
  | "clock"
  | "close"
  | "command"
  | "database"
  | "layers"
  | "logout"
  | "menu"
  | "pause"
  | "search"
  | "settings"
  | "shield"
  | "spark"
  | "wallet";

const iconContent: Record<IconName, ReactNode> = {
  activity: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
  alert: <><path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
  "arrow-down": <><path d="M12 5v14m-7-7 7 7 7-7" /></>,
  "arrow-up-right": <><path d="M7 17 17 7M7 7h10v10" /></>,
  bot: <><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 3v4m-5 5h.01M17 12h.01M9 16h6" /><path d="M2 12h2m16 0h2" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  "chevron-down": <><path d="m6 9 6 6 6-6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  close: <><path d="m18 6-12 12M6 6l12 12" /></>,
  command: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
  logout: <><path d="M10 17l5-5-5-5m5 5H3" /><path d="M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6" /></>,
  menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  pause: <><path d="M8 5v14m8-14v14" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.7 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.7-1l-1.7.6-1.4-2.4L7.3 15a8 8 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.7-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.7 1l1.7-.6 1.4 2.4-1.4 1.1a8 8 0 0 1-.1 2Z" /></>,
  shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
  spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" /><path d="m19 14 1 2.5 2.5 1-2.5 1L19 21l-1-2.5-2.5-1 2.5-1L19 14Z" /></>,
  wallet: <><rect x="3" y="5" width="18" height="15" rx="3" /><path d="M3 9h18m-5 5h2" /><path d="M7 5V3h10v2" /></>,
};

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {iconContent[name]}
    </svg>
  );
}

type BotStatus = "Aktif" | "Siaga" | "Demo saja" | "Dinonaktifkan";

const bots: { id: string; name: string; detail: string; status: BotStatus }[] = [
  { id: "B01", name: "CRAWLER", detail: "Pemantauan instrumen", status: "Aktif" },
  { id: "B02", name: "SCAN", detail: "Penyaring pasar", status: "Aktif" },
  { id: "B03", name: "VET", detail: "Pemeriksaan aset", status: "Siaga" },
  { id: "B04", name: "SOCIAL", detail: "Kanal sosial", status: "Dinonaktifkan" },
  { id: "B05", name: "REGIME", detail: "Kondisi pasar", status: "Siaga" },
  { id: "B06", name: "STRATEGIST", detail: "Evaluasi strategi", status: "Demo saja" },
  { id: "B07", name: "SIZE", detail: "Simulasi ukuran", status: "Demo saja" },
  { id: "B08", name: "RISK", detail: "Gerbang risiko", status: "Siaga" },
  { id: "B09", name: "CHIEF", detail: "Agregasi keputusan", status: "Siaga" },
  { id: "B10", name: "EXECUTOR", detail: "Eksekusi simulasi", status: "Demo saja" },
  { id: "B11", name: "RECON", detail: "Rekonsiliasi", status: "Siaga" },
  { id: "B12", name: "SENTINEL", detail: "Pengawasan sistem", status: "Aktif" },
];

const statusClass: Record<BotStatus, string> = {
  Aktif: "status-ok",
  Siaga: "status-warn",
  "Demo saja": "status-demo",
  Dinonaktifkan: "status-muted",
};

const navigation: { href: string; label: string; icon: IconName }[] = [
  { href: "#command-center", label: "Command Center", icon: "command" },
  { href: "#strategy-lab", label: "Strategy Lab", icon: "spark" },
  { href: "#execution", label: "Execution", icon: "layers" },
  { href: "#risk-center", label: "Risk Center", icon: "shield" },
  { href: "#portfolio", label: "Portfolio", icon: "wallet" },
  { href: "#operations", label: "Operations", icon: "activity" },
];

function StatusPill({ children, tone = "ok" }: { children: ReactNode; tone?: "ok" | "warn" | "muted" | "danger" }) {
  return (
    <span className={`status-pill status-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

function MetricCard({
  label,
  value,
  note,
  icon,
  trend,
  accent,
}: {
  label: string;
  value: string;
  note: string;
  icon: IconName;
  trend?: string;
  accent: "cyan" | "green" | "pink" | "amber";
}) {
  return (
    <article className={`metric-card accent-${accent}`}>
      <div className="metric-top">
        <span>{label}</span>
        <span className="metric-icon"><Icon name={icon} size={17} /></span>
      </div>
      <strong className="metric-value">{value}</strong>
      <div className="metric-foot">
        <span className={trend ? "positive" : ""}>{trend && <Icon name="arrow-up-right" size={13} />}{note}</span>
        <span className="fixture-caption">FIXTURE</span>
      </div>
    </article>
  );
}

function BotCard({ bot }: { bot: (typeof bots)[number] }) {
  const icon = bot.status === "Dinonaktifkan" ? "pause" : bot.status === "Aktif" ? "activity" : "bot";
  return (
    <article className="bot-card">
      <div className="bot-card-top">
        <span className="bot-icon"><Icon name={icon} size={17} /></span>
        <span className="bot-id">{bot.id}</span>
      </div>
      <h3>{bot.name}</h3>
      <p>{bot.detail}</p>
      <span className={`bot-status ${statusClass[bot.status]}`}>
        <span className="status-dot" aria-hidden="true" />
        {bot.status}
      </span>
    </article>
  );
}

function SectionTitle({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return (
    <div className="section-title">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

export type DashboardIdentity = {
  displayName: string;
  email: string;
  workspaceName: string;
  workspaceKind: "personal" | "team";
  roles: WorkspaceRole[];
};

export default function DashboardClient({ identity }: { identity: DashboardIdentity }) {
  const [haltDialogOpen, setHaltDialogOpen] = useState(false);
  const [halted, setHalted] = useState(false);
  const [toast, setToast] = useState("");
  const [activeSection, setActiveSection] = useState("#command-center");
  const haltTriggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const dialogCancelRef = useRef<HTMLButtonElement>(null);
  const initials = identity.displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const primaryRole = identity.roles[0];

  useEffect(() => {
    if (!haltDialogOpen) {
      return;
    }

    const haltTrigger = haltTriggerRef.current;
    dialogCancelRef.current?.focus();

    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setHaltDialogOpen(false);
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusableElements?.length) {
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    }

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      haltTrigger?.focus();
    };
  }, [haltDialogOpen]);

  function confirmHalt() {
    setHalted(true);
    setHaltDialogOpen(false);
    setToast("Simulasi dihentikan. Tidak ada order atau koneksi dana yang terpengaruh.");
    window.setTimeout(() => setToast(""), 5000);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Navigasi utama">
        <a className="brand" href="#command-center" aria-label="NEON LAB, Command Center">
          <span className="brand-mark"><span /></span>
          <span className="brand-copy"><strong>NEON<span>LAB</span></strong><small>TRADING CONTROL</small></span>
        </a>

        <div className="workspace-switcher">
          <span className="workspace-avatar">{initials.slice(0, 1)}</span>
          <span className="workspace-copy"><strong>{identity.workspaceName}</strong><small>{identity.workspaceKind === "personal" ? "Personal" : "Team"}</small></span>
          <Icon name="chevron-down" size={15} />
        </div>

        <p className="nav-label">WORKSPACE</p>
        <nav className="nav-list">
          {navigation.map((item) => (
            <a
              aria-label={item.label}
              className={`nav-link ${activeSection === item.href ? "nav-link-active" : ""}`}
              href={item.href}
              onClick={() => setActiveSection(item.href)}
              key={item.href}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {item.label === "Operations" && <span className="nav-count">2</span>}
            </a>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-health">
            <span className="health-icon"><Icon name="database" size={16} /></span>
            <span><strong>Semua sistem siap</strong><small>Data fixture tersedia</small></span>
            <span className="health-dot" aria-label="Status sehat" />
          </div>
          <a className="profile-button" href="/security/mfa" aria-label="Pengaturan keamanan dan MFA">
            <span className="profile-avatar">{initials}</span>
            <span className="profile-copy"><strong>{identity.displayName}</strong><small>{primaryRole ? workspaceRoleLabels[primaryRole] : "Member"}</small><small>{identity.email}</small></span>
            <Icon name="settings" size={17} />
          </a>
        </div>
      </aside>

      <main id="command-center" className="main-content">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-separator">/</span><strong>Command Center</strong></div>
          <div className="topbar-actions">
            <span className="clock-label"><Icon name="clock" size={15} /> 18:42:16 UTC</span>
            <button type="button" className="icon-button" aria-label="Cari"><Icon name="search" /></button>
            <button type="button" className="icon-button notification-button" aria-label="Notifikasi, 2 belum dibaca">
              <span className="notification-dot" />
              <Icon name="alert" />
            </button>
            <a className="topbar-avatar" href="/security/mfa" aria-label={`Keamanan akun ${identity.displayName}`}>{initials}</a>
            <form action={signOutAction}>
              <button type="submit" className="icon-button" aria-label="Keluar dari akun" title="Keluar">
                <Icon name="logout" size={17} />
              </button>
            </form>
          </div>
        </header>

        <div className="content-wrap">
          <div className="mode-banner">
            <div className="mode-banner-copy">
              <span className="mode-icon"><Icon name="spark" size={17} /></span>
              <div><strong>MODE DEMO</strong><span>Data simulasi · tidak terhubung ke dana atau bursa</span></div>
            </div>
            <div className="mode-banner-meta"><span className="mode-live-dot" /> FIXTURE ENVIRONMENT <span className="banner-divider" /> <span>PRD 4.4</span></div>
          </div>

          {halted && (
            <div className="halted-banner" role="status">
              <Icon name="pause" size={17} />
              <span><strong>Simulasi dijeda.</strong> Tidak ada aksi trading yang dikirim.</span>
              <button type="button" onClick={() => { setHalted(false); setToast("Simulasi dilanjutkan."); window.setTimeout(() => setToast(""), 5000); }}>Lanjutkan simulasi</button>
            </div>
          )}

          <section className="welcome-row">
            <div>
              <p className="eyebrow">SENIN, 12 OKTOBER 2026 <span className="eyebrow-line" /></p>
              <h1>Selamat malam, {identity.displayName} <span className="wave">✳</span></h1>
              <p className="welcome-subtitle">Berikut ringkasan aktivitas workspace Anda hari ini.</p>
            </div>
            <button ref={haltTriggerRef} type="button" className={`halt-button ${halted ? "halt-button-active" : ""}`} onClick={() => setHaltDialogOpen(true)}>
              <Icon name={halted ? "check" : "pause"} size={16} />
              {halted ? "SIMULASI DIJEDA" : "HALT SIMULASI"}
            </button>
          </section>

          <section aria-label="Ringkasan akun demo" className="metrics-grid">
            <MetricCard label="Total ekuitas" value="$24,835.20" note="+3.48% hari ini" trend="+$835.20" icon="wallet" accent="cyan" />
            <MetricCard label="Kas tersedia" value="$18,420.25" note="74.2% dari ekuitas" icon="database" accent="green" />
            <MetricCard label="PnL bersih" value="+$835.20" note="Hari ini · setelah biaya" trend="+3.48%" icon="arrow-up-right" accent="pink" />
            <MetricCard label="Drawdown" value="−2.40%" note="Batas simulasi: −8.00%" icon="arrow-down" accent="amber" />
          </section>

          <div className="summary-strip" aria-label="Ringkasan eksposur dan order">
            <div><span className="summary-icon cyan-text"><Icon name="layers" size={16} /></span><span>Eksposur terbuka</span><strong>$3,864.95</strong></div>
            <span className="strip-divider" />
            <div><span className="summary-icon amber-text"><Icon name="wallet" size={16} /></span><span>Kas terikat</span><strong>$2,550.00</strong></div>
            <span className="strip-divider" />
            <div><span className="summary-icon pink-text"><Icon name="activity" size={16} /></span><span>Order belum selesai</span><strong>02 <small>simulasi</small></strong></div>
            <span className="summary-updated"><Icon name="clock" size={13} /> Diperbarui 18:42:16 UTC</span>
          </div>

          <div className="overview-grid">
            <section className="panel chart-panel" aria-label="Pergerakan ekuitas">
              <SectionTitle
                eyebrow="PERFORMA PORTOFOLIO"
                title="Pergerakan ekuitas"
                action={<button type="button" className="period-button">7 hari <Icon name="chevron-down" size={14} /></button>}
              />
              <div className="chart-legend"><span className="legend-line" /> Ekuitas <span className="legend-dot" /> Saldo awal</div>
              <div className="chart-wrap">
                <div className="chart-y-labels"><span>$25k</span><span>$24k</span><span>$23k</span><span>$22k</span></div>
                <svg className="equity-chart" viewBox="0 0 720 210" role="img" aria-labelledby="equity-chart-title equity-description" preserveAspectRatio="none">
                  <title id="equity-chart-title">Grafik pergerakan ekuitas selama tujuh hari</title>
                  <desc id="equity-description">Grafik fixture simulasi menunjukkan tren ekuitas meningkat secara bertahap dari sekitar dua puluh tiga ribu delapan ratus dolar ke dua puluh empat ribu delapan ratus tiga puluh lima dolar.</desc>
                  <defs>
                    <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#00d4ff" stopOpacity=".2" /><stop offset="100%" stopColor="#00d4ff" stopOpacity="0" /></linearGradient>
                  </defs>
                  <path className="grid-line" d="M0 22H720M0 75H720M0 128H720M0 181H720" />
                  <path className="baseline-line" d="M0 128H720" />
                  <path className="chart-area" d="M0 154 C40 147 43 129 82 135 S130 150 165 126 S212 110 245 119 S298 100 330 105 S380 117 414 88 S465 91 496 75 S544 84 578 56 S627 68 655 44 S696 55 720 25 V190 H0Z" />
                  <path className="chart-line" d="M0 154 C40 147 43 129 82 135 S130 150 165 126 S212 110 245 119 S298 100 330 105 S380 117 414 88 S465 91 496 75 S544 84 578 56 S627 68 655 44 S696 55 720 25" />
                  <circle className="chart-endpoint" cx="720" cy="25" r="5" />
                </svg>
              </div>
              <div className="chart-x-labels"><span>06 Okt</span><span>07 Okt</span><span>08 Okt</span><span>09 Okt</span><span>10 Okt</span><span>11 Okt</span><span>12 Okt</span></div>
              <p className="chart-footnote"><span className="fixture-caption">DATA FIXTURE</span> Nilai historis simulasi · bukan performa aktual</p>
            </section>

            <section className="panel decision-panel" id="risk-center" aria-labelledby="decision-title">
              <SectionTitle eyebrow="DECISION ENGINE" title="Keputusan terbaru" action={<button className="text-link" type="button">Lihat detail <Icon name="arrow-up-right" size={14} /></button>} />
              <div className="decision-status">
                <span className="decision-status-icon"><Icon name="shield" size={20} /></span>
                <div><StatusPill tone="warn">NO_TRADE</StatusPill><strong>Menunggu kondisi yang lebih baik</strong></div>
              </div>
              <p className="decision-reason">Spread 0.82% melebihi batas strategi 0.50%. Sistem tidak membuat order.</p>
              <div className="decision-meta"><span>Instrumen</span><strong>SOL / USDT</strong><span>Waktu pemeriksaan</span><strong>18:39:52 UTC</strong></div>
              <div className="decision-flow" aria-label="Tahapan evaluasi keputusan">
                <div className="flow-step flow-done"><span><Icon name="check" size={12} /></span><small>DATA</small></div>
                <i />
                <div className="flow-step flow-done"><span><Icon name="check" size={12} /></span><small>SCAN</small></div>
                <i />
                <div className="flow-step flow-done"><span><Icon name="check" size={12} /></span><small>VET</small></div>
                <i />
                <div className="flow-step flow-blocked"><span><Icon name="close" size={12} /></span><small>RISK</small></div>
                <i />
                <div className="flow-step flow-wait"><span>—</span><small>ORDER</small></div>
              </div>
              <div className="decision-footer"><Icon name="clock" size={13} /> Fixture diperbarui 2 menit lalu <span>·</span> Ref: DEC-DEMO-0042</div>
            </section>
          </div>

          <section className="panel orders-panel" id="execution" aria-labelledby="orders-title">
            <SectionTitle
              eyebrow="EXECUTION CONSOLE"
              title="Order simulasi"
              action={<a className="text-link" href="#execution-history">Semua order <Icon name="arrow-up-right" size={14} /></a>}
            />
            <div className="table-scroll">
              <table>
                <thead><tr><th>INSTRUMEN</th><th>SISI</th><th>JENIS</th><th>KUANTITAS</th><th>HARGA</th><th>STATUS</th><th>WAKTU</th></tr></thead>
                <tbody>
                  <tr>
                    <td><span className="asset-cell"><span className="coin-icon sol">S</span><span><strong>SOL / USDT</strong><small>Solana</small></span></span></td>
                    <td><span className="buy-label">BELI</span></td><td>Limit</td><td>12.5000 SOL</td><td>$184.20</td><td><StatusPill tone="warn">MENUNGGU</StatusPill></td><td>18:36:04</td>
                  </tr>
                  <tr>
                    <td><span className="asset-cell"><span className="coin-icon eth">Ξ</span><span><strong>ETH / USDT</strong><small>Ethereum</small></span></span></td>
                    <td><span className="sell-label">JUAL</span></td><td>Market</td><td>0.4200 ETH</td><td>$3,842.10</td><td><StatusPill tone="ok">TERISI</StatusPill></td><td>18:21:39</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="panel-footnote"><Icon name="alert" size={14} /> Order ini hanya data fixture. Tidak ada order yang dikirim ke bursa.</div>
          </section>

          <section className="bot-room-section" id="operations">
            <SectionTitle
              eyebrow="BOT ROOM · 12 MODUL"
              title="Status modul"
              action={<span className="section-count"><span className="health-dot" /> 3 aktif <span className="section-count-divider" /> 9 siaga / demo</span>}
            />
            <div className="bot-grid">
              {bots.map((bot) => <BotCard key={bot.id} bot={bot} />)}
            </div>
            <p className="bot-room-note"><Icon name="alert" size={14} /> Status adalah fixture demonstrasi, bukan proses bot yang berjalan.</p>
          </section>

          <div className="lower-grid">
            <section className="panel mini-panel" id="strategy-lab">
              <SectionTitle eyebrow="STRATEGY LAB" title="Strategi dalam demo" action={<button className="text-link" type="button">Buka lab <Icon name="arrow-up-right" size={14} /></button>} />
              <div className="strategy-row">
                <span className="strategy-icon"><Icon name="activity" size={18} /></span>
                <div className="strategy-copy"><strong>SMA_CROSS_3_5_FIXTURE</strong><small>v1.0.0 · SOL, ETH · diperbarui 12 Okt</small></div>
                <StatusPill tone="muted">PAPER ONLY</StatusPill>
              </div>
              <p className="small-note">Strategi contoh untuk alur demo. Belum divalidasi untuk penggunaan nyata.</p>
            </section>
            <section className="panel mini-panel" id="portfolio">
              <SectionTitle eyebrow="PORTFOLIO" title="Posisi simulasi" action={<button className="text-link" type="button">Rincian <Icon name="arrow-up-right" size={14} /></button>} />
              <div className="position-row"><span className="coin-icon sol">S</span><span className="position-name"><strong>Solana</strong><small>SOL · rata-rata $178.40</small></span><span className="position-value"><strong>$2,931.60</strong><small className="positive">+$93.20 (3.28%)</small></span></div>
              <div className="position-row"><span className="coin-icon eth">Ξ</span><span className="position-name"><strong>Ethereum</strong><small>ETH · rata-rata $3,710.00</small></span><span className="position-value"><strong>$933.35</strong><small className="positive">+$20.55 (2.25%)</small></span></div>
            </section>
          </div>

          <footer className="page-footer"><span>NEON LAB <span className="footer-separator">·</span> Prototype P0</span><span><span className="mode-live-dot" /> SEMUA DATA ADALAH SIMULASI</span><a href="#command-center">Kembali ke atas ↑</a></footer>
        </div>
      </main>

      {haltDialogOpen && (
        <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setHaltDialogOpen(false); }}>
          <section ref={dialogRef} className="halt-dialog" role="dialog" aria-modal="true" aria-labelledby="halt-title" aria-describedby="halt-description">
            <div className="dialog-icon"><Icon name="pause" size={22} /></div>
            <button type="button" className="dialog-close icon-button" aria-label="Tutup dialog" onClick={() => setHaltDialogOpen(false)}><Icon name="close" size={17} /></button>
            <p className="eyebrow">KONTROL DEMO</p>
            <h2 id="halt-title">Jeda simulasi?</h2>
            <p id="halt-description">Ini hanya mengubah tampilan demo pada halaman ini. Tidak ada bot sungguhan, order, akun bursa, atau dana yang terhubung.</p>
            <div className="dialog-actions">
              <button ref={dialogCancelRef} type="button" className="secondary-button" onClick={() => setHaltDialogOpen(false)}>Kembali</button>
              <button type="button" className="confirm-halt-button" onClick={confirmHalt}><Icon name="pause" size={15} /> Jeda demo</button>
            </div>
          </section>
        </div>
      )}

      {toast && <div className="toast-message" role="status"><Icon name="check" size={17} />{toast}<button type="button" aria-label="Tutup notifikasi" onClick={() => setToast("")}><Icon name="close" size={15} /></button></div>}
    </div>
  );
}
