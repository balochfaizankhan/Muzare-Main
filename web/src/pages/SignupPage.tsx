import { zodResolver } from "@hookform/resolvers/zod";
import { Building2, CheckCircle2, ClipboardCheck, ShieldCheck, Sprout } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { z } from "zod";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { signup } from "../lib/api";

const schema = z.object({
  workspaceName: z.string().min(2, "Workspace name is required."),
  ownerName: z.string().min(2, "Your name is required."),
  email: z.email("Use a valid email."),
  phone: z.string().optional(),
  password: z.string().min(8, "Use at least 8 characters."),
});

type SignupFields = z.infer<typeof schema>;

export function SignupPage() {
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupFields>({
    resolver: zodResolver(schema),
    defaultValues: { workspaceName: "", ownerName: "", email: "", phone: "", password: "" },
  });

  const submit = async (fields: SignupFields) => {
    setError(null);
    const result = await signup(fields).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "Unable to submit request.");
      return null;
    });
    if (!result) return;
    setMessage(result.message);
    setSubmitted(true);
  };

  return (
    <main className="onboarding-page">
      <div className="login-language">
        <LanguageSwitch />
      </div>
      <section className="onboarding-shell">
        <div className="onboarding-story">
          <Brand />
          <div className="journey-steps" aria-label="Onboarding journey">
            <article>
              <Building2 size={18} />
              <div>
                <strong>Create workspace</strong>
                <span>Tell us the farm operation this account will manage.</span>
              </div>
            </article>
            <article>
              <ShieldCheck size={18} />
              <div>
                <strong>Admin approval</strong>
                <span>An administrator reviews every signup before access is granted.</span>
              </div>
            </article>
            <article>
              <Sprout size={18} />
              <div>
                <strong>Start clean</strong>
                <span>Your workspace data stays separated from every other farm.</span>
              </div>
            </article>
          </div>
        </div>

        <section className="onboarding-panel">
          {submitted ? (
            <div className="approval-state">
              <CheckCircle2 size={38} />
              <h1>Request received</h1>
              <p>{message ?? "Your workspace request is waiting for administrator approval."}</p>
              <Link className="primary-link" to="/login">Back to login</Link>
            </div>
          ) : (
            <>
              <div className="onboarding-heading">
                <ClipboardCheck size={22} />
                <div>
                  <h1>Request a workspace</h1>
                  <p>No payment needed. Access starts after administrator approval.</p>
                </div>
              </div>
              <form className="module-form onboarding-form" onSubmit={handleSubmit(submit)}>
                <label>
                  <span>Workspace name</span>
                  <input placeholder="Example: Green Valley Farms" {...register("workspaceName")} />
                  {errors.workspaceName && <small>{errors.workspaceName.message}</small>}
                </label>
                <label>
                  <span>Your name</span>
                  <input placeholder="Owner or manager name" {...register("ownerName")} />
                  {errors.ownerName && <small>{errors.ownerName.message}</small>}
                </label>
                <label>
                  <span>Email</span>
                  <input type="email" autoComplete="email" placeholder="you@farm.com" {...register("email")} />
                  {errors.email && <small>{errors.email.message}</small>}
                </label>
                <label>
                  <span>Phone</span>
                  <input placeholder="+966..." {...register("phone")} />
                </label>
                <label>
                  <span>Password</span>
                  <input type="password" autoComplete="new-password" {...register("password")} />
                  {errors.password && <small>{errors.password.message}</small>}
                </label>
                {error && <p className="error">{error}</p>}
                <button type="submit" disabled={isSubmitting}>{isSubmitting ? "Submitting..." : "Submit for approval"}</button>
              </form>
              <p className="auth-switch">Already approved? <Link to="/login">Sign in</Link></p>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
