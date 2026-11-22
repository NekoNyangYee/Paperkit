import { useState } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";
import type { SignatureReport } from "@/shared/pdf/types";

const trustLabels = {
  trusted: "Windows에서 신뢰함",
  untrusted: "신뢰되지 않거나 유효기간이 지난 인증서",
  revoked: "폐기된 인증서",
  unknown: "신뢰 또는 폐기 여부 확인 불가",
};
const integrityLabels = {
  matches: "서명된 바이트 일치",
  mismatch: "서명된 데이터 불일치",
  unverified: "검증 불가",
};

export function SignatureStatus({ reports }: { reports: SignatureReport[] }) {
  const [open, setOpen] = useState(false);
  const trusted = reports.every(
    (r) => r.integrity === "matches" && r.trust === "trusted" && r.laterBytes === false,
  );
  const Icon = trusted ? ShieldCheck : ShieldAlert;
  const status = reports.some((r) => r.integrity === "mismatch")
    ? "서명 불일치"
    : reports.some((r) => r.laterBytes)
      ? "서명 후 변경 있음"
      : trusted
        ? "서명 확인됨"
        : "서명 확인 필요";
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title="원본 디지털 서명 검증 결과"
      >
        <Icon size={16} />
        원본 {status}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(92vw,480px)] p-6">
          <DialogTitle className="text-lg font-semibold">원본 디지털 서명</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-stone-600">
            파일을 열었을 때의 원본과 이 컴퓨터의 Windows 인증서 정보를 기준으로 확인했습니다.
          </DialogDescription>
          <div className="mt-4 divide-y">
            {reports.map((r, i) => (
              <section key={i} className="py-3 text-sm">
                <h3 className="font-semibold">{r.signer ?? "서명자 확인 불가"}</h3>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  <dt>무결성</dt>
                  <dd>{integrityLabels[r.integrity]}</dd>
                  <dt>인증서</dt>
                  <dd>{trustLabels[r.trust]}</dd>
                  <dt>서명 이후</dt>
                  <dd>
                    {r.laterBytes === null
                      ? "확인 불가"
                      : r.laterBytes
                        ? "추가 데이터 있음"
                        : "추가 데이터 없음"}
                  </dd>
                </dl>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
