import { useNavigate } from "react-router-dom";
import { ModulePage } from "../ModulePage";

export function Advances() {
  const navigate = useNavigate();
  return <ModulePage module="workforce" workforceMode="advance" onAdvanceClose={() => {
    if (window.history.length > 1) navigate(-1);
    else navigate("/workspace/dashboard");
  }} />;
}
