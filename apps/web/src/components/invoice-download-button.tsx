'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api-client';
import { fetchInvoiceUrl } from '@/lib/billing-checkout';

// One invoice PDF. The link is minted on click because it expires; the PDF
// downloads as an attachment, so the vendor stays on the billing page.
export function InvoiceDownloadButton({
  transactionId,
  invoiceNumber,
}: {
  transactionId: string;
  invoiceNumber: string;
}) {
  const [pending, setPending] = useState(false);

  async function onClick(): Promise<void> {
    setPending(true);
    try {
      window.location.assign(await fetchInvoiceUrl(transactionId));
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      loading={pending}
      loadingText="Preparing invoice…"
      onClick={() => void onClick()}
      aria-label={`Download invoice ${invoiceNumber} (PDF)`}
      data-testid={`invoice-download-${transactionId}`}
    >
      <Download aria-hidden className="size-4" />
      PDF
    </Button>
  );
}
