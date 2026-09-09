import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Workspace metadata and reference lists change infrequently and are explicitly
      // invalidated after mutations. Keep successful data warm long enough that normal
      // navigation renders from cache instead of repeatedly showing loading states.
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
});
