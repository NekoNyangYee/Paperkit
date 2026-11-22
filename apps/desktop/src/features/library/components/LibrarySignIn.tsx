import { X, LogIn } from "lucide-react";
import {
  cancelGoogleLogin,
  signInWithGoogle,
  useAuthStore,
} from "@/features/auth/model/auth-store";
import { authConfig } from "@/features/auth/lib/client";
import { Button } from "@/shared/ui/button";

export function LibrarySignIn() {
  const { ready, busy, signingIn, error } = useAuthStore();
  return (
    <div className="py-7 text-sm leading-6 text-stone-500">
      <Button
        variant="outline"
        size="sm"
        disabled={!authConfig || (!signingIn && (busy || !ready))}
        onClick={() => void (signingIn ? cancelGoogleLogin() : signInWithGoogle())}
      >
        {signingIn ? <X size={16} aria-hidden="true" /> : <LogIn size={16} aria-hidden="true" />}
        {signingIn ? "로그인 취소" : "로그인"}
      </Button>
      {error && (
        <p role="alert" className="mt-3 text-xs leading-5 text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
