import { ModulePage } from "../ModulePage";
import { useAppBack } from "../../hooks/useAppBack";

export function Advances() {
  const back = useAppBack("/workspace/workforce/labour");
  return <ModulePage module="workforce" workforceMode="advance" onAdvanceClose={back} />;
}
