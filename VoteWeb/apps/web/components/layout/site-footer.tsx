import Link from 'next/link';
import { ExternalLink } from 'lucide-react';

const DISCORD_INVITE_URL = 'https://discord.gg/HPh2xYjSVH';
const TWITTER_URL = 'https://x.com';

export function SiteFooter() {
  return (
    <footer className="border-t border-[#272c33] bg-[#0b0d10] pb-8 pt-12 text-[#a9b0ba]">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-8 grid grid-cols-1 gap-8 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Link className="mb-4 flex items-center gap-2" href="/">
              <div className="flex h-7 w-7 items-center justify-center rounded-md border border-emerald-400/30 bg-emerald-400 text-xs font-bold text-[#0b0d10]">
                L
              </div>
              <span className="text-lg font-bold text-white">
                Lunaf<span className="text-[#13ec80]">.kr</span>
              </span>
            </Link>
            <p className="max-w-sm text-sm leading-6">
              한국 마인크래프트 서버를 등록하고, 검증 상태와 리뷰를 기준으로 비교할 수 있는 서버
              목록 서비스입니다.
            </p>
          </div>

          <FooterCol title="탐색" links={['서버 목록', 'Java 서버', 'Bedrock 서버', '신규 서버']} />
          <FooterCol title="지원" links={['고객센터', '운영 문의', '서버 신고', '계정 도움말']} />
          <div>
            <h4 className="mb-4 text-sm font-bold text-white">정책</h4>
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

        <div className="flex flex-col items-start justify-between gap-4 border-t border-[#272c33] pt-8 md:flex-row md:items-center">
          <p className="text-xs">© 2026 Lunaf.kr. Mojang Studios와 공식 제휴 관계가 없습니다.</p>
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

function FooterCol({ title, links }: { readonly title: string; readonly links: string[] }) {
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
        return { href: '/support?type=report', external: false };
      }
    }
    return { href: '/', external: false };
  };

  return (
    <div>
      <h4 className="mb-4 text-sm font-bold text-white">{title}</h4>
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
