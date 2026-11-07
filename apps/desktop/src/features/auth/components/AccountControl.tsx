import { useEffect, useId, useState } from "react";
import { Info, LogIn, LogOut, UserRound, X } from "lucide-react";
import { VersionDialog } from "@/features/about/components/VersionDialog";
import { Button } from "@/shared/ui/button";
import { IconButton } from "@/shared/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { authConfig } from "@/features/auth/lib/client";
import {
  cancelGoogleLogin,
  initializeAuth,
  signInWithGoogle,
  signOut,
  useAuthStore,
} from "@/features/auth/model/auth-store";

function profileText(...values: unknown[]) {
  return values
    .find((value): value is string => typeof value === "string" && !!value.trim())
    ?.trim();
}

function profilePicture(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".googleusercontent.com")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function ProfileAvatar({
  name,
  source,
  compact = false,
}: {
  name: string;
  source: string | null;
  compact?: boolean;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const showPhoto = !!source && failedSource !== source;
  return (
    <div
      className={`mx-auto flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-stone-100 text-stone-400 ${compact ? "size-6" : "size-14"}`}
      aria-hidden={compact || undefined}
      role={showPhoto ? undefined : "img"}
      aria-label={showPhoto ? undefined : "기본 프로필"}
    >
      {showPhoto ? (
        <img
          src={source}
          alt={`${name} 프로필 사진`}
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <UserRound size={compact ? 19 : 28} aria-hidden="true" />
      )}
    </div>
  );
}

export function AccountControl() {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const { session, ready, busy, signingIn, error, storageError, dismissError } = useAuthStore();
  const metadata = session?.user.user_metadata;
  const profileName = profileText(metadata?.full_name, metadata?.name) ?? "Google 계정";
  const picture = profilePicture(metadata?.avatar_url) ?? profilePicture(metadata?.picture);
  useEffect(() => {
    if (authConfig) void initializeAuth();
  }, []);
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) dismissError();
        }}
      >
        <PopoverTrigger asChild>
          {session ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="내 계정"
              title="내 계정"
              className="shrink-0"
            >
              <ProfileAvatar key={session.user.id} name={profileName} source={picture} compact />
            </Button>
          ) : (
            <IconButton icon={UserRound} label="로그인" className="shrink-0" />
          )}
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          sideOffset={10}
          collisionPadding={12}
          aria-labelledby={titleId}
          onCloseAutoFocus={(event) => {
            if (aboutOpen) event.preventDefault();
          }}
          className="w-72 max-w-[calc(100vw-24px)] space-y-4 p-4"
        >
          <div className="space-y-3 text-center">
            <ProfileAvatar key={session?.user.id ?? "guest"} name={profileName} source={picture} />
            <h2 id={titleId} className="break-words text-sm font-semibold text-stone-900">
              {session ? profileName : ready ? "로그인이 필요합니다" : "로그인 확인 중"}
            </h2>
            {session && <p className="break-all text-xs text-stone-500">{session.user.email}</p>}
            {!session && !ready && (
              <p className="text-xs leading-5 text-stone-500">저장된 계정을 확인하고 있습니다.</p>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-stone-100 pt-3">
            <Button
              variant="ghost"
              className="flex-1 gap-2"
              onClick={() => {
                setOpen(false);
                setAboutOpen(true);
              }}
            >
              <Info size={16} aria-hidden="true" />앱 정보
            </Button>
            {session ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void signOut()}
                className="flex-1 gap-2"
              >
                <LogOut size={16} />
                로그아웃
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={!signingIn && (busy || !ready)}
                onClick={() => void (signingIn ? cancelGoogleLogin() : signInWithGoogle())}
                className="flex-1 gap-2"
                aria-label={signingIn ? "로그인 취소" : "Google로 로그인"}
              >
                {signingIn ? <X size={17} /> : <LogIn size={17} />}
                {signingIn ? "로그인 취소" : "로그인"}
              </Button>
            )}
          </div>
          {(error || storageError) && (
            <p role="alert" className="text-xs leading-5 text-red-700">
              {error ?? storageError}
            </p>
          )}
        </PopoverContent>
      </Popover>
      <VersionDialog open={aboutOpen} onOpenChange={setAboutOpen} hideTrigger />
    </>
  );
}
