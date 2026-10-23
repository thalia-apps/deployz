import { DeployzBrand } from '@/components/deployz-brand';
import { DocsLink } from '@/components/docs-link';
import { DOCS } from '@/lib/docs-links';

// The header of every customer page (/install, /deploy and their security
// pages): the brand, and the Customer guide where the customer sees it first.
export function CustomerPageHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4">
        <DeployzBrand size="sm" />
        <DocsLink href={DOCS.customerGuide}>Customer guide</DocsLink>
      </div>
    </header>
  );
}
