const value = (key: string): string | undefined => {
  const result = import.meta.env[key] as string | undefined;
  return result?.trim() || undefined;
};

const booleanValue = (key: string, fallback: boolean): boolean => {
  const result = value(key);
  if (!result) return fallback;
  return ["1", "true", "yes", "on"].includes(result.toLowerCase());
};

export const config = {
  apiUrl: value("VITE_API_URL") ?? "http://localhost:3001",
  featureFarmMap: booleanValue("VITE_FEATURE_FARM_MAP", false),
  featureInventory: booleanValue("VITE_ENABLE_INVENTORY", false),
};
