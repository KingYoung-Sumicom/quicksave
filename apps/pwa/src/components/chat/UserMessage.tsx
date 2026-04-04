export function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="bg-blue-600 rounded-lg rounded-br-sm px-3 py-2 max-w-[85%] text-sm whitespace-pre-wrap break-words">
        {content}
      </div>
    </div>
  );
}
