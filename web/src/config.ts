const value = (key: string): string | undefined => {
  const result = import.meta.env[key] as string | undefined;
  return result?.trim() || undefined;
};

export const config = {
  apiUrl: value("VITE_API_URL") ?? "http://localhost:3001",
};
