import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

export function useAppBack(fallbackPath: string) {
  const navigate = useNavigate();

  return useCallback(() => {
    const historyIndex = typeof window !== "undefined" ? window.history.state?.idx : undefined;
    if (typeof historyIndex === "number" && historyIndex > 0) {
      navigate(-1);
      return;
    }
    navigate(fallbackPath, { replace: true });
  }, [fallbackPath, navigate]);
}
