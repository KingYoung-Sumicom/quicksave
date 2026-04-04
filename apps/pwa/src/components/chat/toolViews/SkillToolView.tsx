export function SkillToolView({ input }: { input: Record<string, unknown> }) {
  const skill = (input.skill as string) || '?';
  const args = input.args as string | undefined;

  return (
    <div>
      <div>
        <span className="text-indigo-400">Skill</span>{' '}
        <span className="font-mono text-blue-400">{skill}</span>
      </div>
      {args && (
        <div className="mt-1 text-slate-400 break-words whitespace-pre-wrap">{args}</div>
      )}
    </div>
  );
}
