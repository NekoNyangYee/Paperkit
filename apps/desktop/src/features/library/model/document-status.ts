import { create } from "zustand";
import { useAuthStore } from "@/features/auth/model/auth-store";

export const useDocumentStatus = create<{
  owner: string | null;
  error: string | null;
  revision: number;
}>(() => ({
  owner: null,
  error: null,
  revision: 0,
}));

useAuthStore.subscribe((state, previous) => {
  if (state.session?.user.id !== previous.session?.user.id)
    useDocumentStatus.setState({ owner: null, error: null, revision: 0 });
});
