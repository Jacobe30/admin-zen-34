import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Tameeni Care — Admin portal" },
      { name: "description", content: "Restricted operations portal for the Tameeni Care team." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="max-w-lg text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Tameeni Care — Admin portal</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The customer website is unchanged and continues to run on its existing infrastructure.
          This portal is for the operations team only.
        </p>
        <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
          <Button asChild>
            <Link to="/auth">Sign in to admin dashboard</Link>
          </Button>
          <Button asChild variant="outline">
            <a href="https://tmin-care1.vercel.app/" target="_blank" rel="noopener noreferrer">
              Customer site <ExternalLink className="ml-1 h-4 w-4" />
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
