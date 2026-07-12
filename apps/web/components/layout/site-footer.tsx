import Link from 'next/link';
import { BookOpenText, ExternalLink } from 'lucide-react';

const DISCORD_INVITE_URL = 'https://discord.gg/HPh2xYjSVH';
const TWITTER_URL = 'https://x.com';

export function SiteFooter({ variant = 'dark' }: { readonly variant?: 'dark' | 'paper' }) {
  const paper = variant === 'paper';
  return (
    <footer className={`site-footer border-t pb-8 pt-12 ${paper ? 'border-[#aaa79e] bg-[#e8e5dc]/85 text-[#5d635c]' : 'border-[#272c33] bg-[#0b0d10] text-[#a9b0ba]'}`}>
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-8 grid grid-cols-1 gap-8 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Link className="mb-4 flex items-center gap-2" href="/">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#123d31] text-[#9af2d5]">
                <BookOpenText className="h-4 w-4" strokeWidth={2.2} />
              </span>
              <span className={`text-lg font-bold ${paper ? 'text-[#252925]' : 'text-white'}`}>
                MineWiki<span className="text-[#13ec80]">.kr</span>
              </span>
            </Link>
            <p className="max-w-sm text-sm leading-6">
              서버 랭킹과 위키 지식을 연결해 발견부터 플레이까지 돕는 한국 마인크래프트 커뮤니티입니다.
            </p>
          </div>

          <FooterCol title="탐색" links={['서버 목록', 'Java 서버', 'Bedrock 서버', '신규 서버']} paper={paper} />
          <FooterCol title="지원" links={['고객센터', '운영 문의', '서버 신고', '계정 도움말']} paper={paper} />
          <div>
            <h4 className={`mb-4 text-sm font-bold ${paper ? 'text-[#252925]' : 'text-white'}`}>정책</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link className="transition-colors hover:text-[#13ec80]" href="/policies/terms">
                  이용약관
                </Link>
              </li>
              <li>
                <Link className="transition-colors hover:text-[#13ec80]" href="/policies/privacy">
                  개인정보처리방침
                </Link>
              </li>
              <li>
                <Link className="transition-colors hover:text-[#13ec80]" href="/policies/usage">
                  운영 정책
                </Link>
              </li>
              <li>
                <Link className="transition-colors hover:text-[#13ec80]" href="/policies/voting">
                  투표 정책
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className={`flex flex-col items-start justify-between gap-4 border-t pt-8 md:flex-row md:items-center ${paper ? 'border-[#aaa79e]' : 'border-[#272c33]'}`}>
          <p className="text-xs">© 2026 MineWiki · minewiki.kr · support@minewiki.kr · Mojang Studios와 공식 제휴 관계가 없습니다.</p>
          <div className="flex gap-4 text-sm">
            <a
              className="inline-flex items-center gap-1 transition-colors hover:text-[#13ec80]"
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Discord
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <a
              className="inline-flex items-center gap-1 transition-colors hover:text-[#13ec80]"
              href={TWITTER_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              X
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links, paper = false }: { readonly title: string; readonly links: string[]; readonly paper?: boolean }) {
  const resolveLink = (label: string): { href: string; external: boolean } => {
    if (title === '탐색') {
      if (label === '서버 목록') {
        return { href: '/servers', external: false };
      }
      if (label === 'Java 서버') {
        return { href: '/servers?edition=java', external: false };
      }
      if (label === 'Bedrock 서버') {
        return { href: '/servers?edition=bedrock', external: false };
      }
      if (label === '신규 서버') {
        return { href: '/servers?sort=latest', external: false };
      }
    }
    if (title === '지원') {
      if (label === '고객센터' || label === '운영 문의' || label === '계정 도움말') {
        return { href: '/support', external: false };
      }
      if (label === '서버 신고') {
        return { href: '/support?category=server_claim', external: false };
      }
    }
    return { href: '/', external: false };
  };

  return (
    <div>
      <h4 className={`mb-4 text-sm font-bold ${paper ? 'text-[#252925]' : 'text-white'}`}>{title}</h4>
      <ul className="space-y-2 text-sm">
        {links.map((label) => {
          const link = resolveLink(label);
          return (
            <li key={label}>
              {link.external ? (
                <a className="transition-colors hover:text-[#13ec80]" href={link.href}>
                  {label}
                </a>
              ) : (
                <Link className="transition-colors hover:text-[#13ec80]" href={link.href}>
                  {label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
