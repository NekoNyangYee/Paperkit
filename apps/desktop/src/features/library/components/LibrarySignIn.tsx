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
        {signingIn ? "로그인 취소" : busy ? "로그인 연결 중…" : "로그인"}
      </Button>
      {error && (
        <p role="alert" className="mt-3 text-xs leading-5 text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
