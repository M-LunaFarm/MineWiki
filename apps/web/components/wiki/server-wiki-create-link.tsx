'use client';

import { useRouter } from 'next/navigation';
import { FilePlus2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { buildServerWikiToolPath } from '../../lib/wiki-routes.mjs';

export function ServerWikiCreateLink({ serverSlug }: { readonly serverSlug: string }) {
  const router = useRouter();
  const [title, setTitle] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = title.trim().replace(/\s+/g, '_');
    if (!normalized) return;
    const routePath = `/server/${encodeURIComponent(serverSlug)}/${encodeURIComponent(normalized)}`;
    router.push(buildServerWikiToolPath(routePath, 'edit'));
  }

  return (
    <form onSubmit={submit} className="mt-4 border-t border-[#e8e8e8] pt-4">
      <label className="text-xs font-semibold text-[#777]" htmlFor="server-wiki-new-title">
        새 문서
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id="server-wiki-new-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={80}
          placeholder="문서 제목"
          className="min-w-0 flex-1 rounded-md border border-[#dedede] bg-white px-3 py-2 text-sm text-[#333] outline-none placeholder:text-[#999] focus:border-[#9ab5ef]"
        />
        <button
          type="submit"
          disabled={!title.trim()}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-[#dedede] text-[#666] transition hover:border-[#9ab5ef] hover:bg-[#f7f9ff] hover:text-[#2458bd] disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="새 위키 문서 작성"
        >
          <FilePlus2 className="size-4" />
        </button>
      </div>
    </form>
  );
}
