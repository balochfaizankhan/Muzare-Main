import { ModulePage } from "../ModulePage";
import { useNavigate } from "react-router-dom";
export function Attendance() {
  const navigate = useNavigate();
  return <ModulePage module="workforce" workforceMode="attendance" onAttendanceClose={() => {
    if (window.history.length > 1) navigate(-1);
    else navigate("/workspace/dashboard");
  }} />;
}
