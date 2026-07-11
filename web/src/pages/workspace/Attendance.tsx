import { ModulePage } from "../ModulePage";
import { useAppBack } from "../../hooks/useAppBack";
export function Attendance() {
  const back = useAppBack("/workspace/workforce/labour");
  return <ModulePage module="workforce" workforceMode="attendance" onAttendanceClose={back} />;
}
