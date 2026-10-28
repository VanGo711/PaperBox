interface BlankPageProps { label: string; }

export function BlankPage({ label }: BlankPageProps) {
  return <div className="page module-blank" aria-label={label} />;
}
