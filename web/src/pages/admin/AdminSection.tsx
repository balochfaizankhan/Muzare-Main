export function AdminSection({ title, description }: { title: string; description: string }) {
  return <main className="shell-page"><section className="shell-page__intro"><span className="eyebrow">Platform administration</span><h1>{title}</h1><p>{description}</p></section></main>;
}
