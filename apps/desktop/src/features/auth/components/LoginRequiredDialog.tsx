import { LogIn, LoaderCircle, UserRound } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/shared/ui/dialog";
import {
  cancelGoogleLogin,
  signInWithGoogle,
  useAuthStore,
} from "@/features/auth/model/auth-store";

export function LoginRequiredDialog({
  open,
  feature,
  description,
  onClose,
}: {
  open: boolean;
  feature: string;
  description?: string;
  onClose: () => void;
}) {
  const { ready, busy, signingIn, error, dismissError } = useAuthStore();
  function close() {
    if (signingIn) void cancelGoogleLogin();
    dismissError();
    onClose();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="w-[min(92vw,360px)] space-y-5 p-6 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-stone-100 text-stone-400">
          <UserRound size={25} aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <DialogTitle className="text-base font-semibold text-stone-900">
            로그인이 필요합니다
          </DialogTitle>
          <DialogDescription className={description ? "text-sm text-stone-600" : "sr-only"}>
            {description ?? `${feature} 기능은 로그인 후 이용할 수 있습니다.`}
          </DialogDescription>
        </div>
        <div className="space-y-2">
          <Button
            className="w-full gap-2"
            disabled={signingIn || busy || !ready}
            aria-busy={signingIn}
            onClick={() => void signInWithGoogle()}
          >
            {signingIn ? <LoaderCircle className="animate-spin" size={17} /> : <LogIn size={17} />}
            Google로 로그인
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs leading-5 text-red-700">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
