import type { InfrastructureSizeTier } from '@deployz/contracts';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { sizeTierCompute, sizeTierLabel } from '@/lib/size-tiers';

/** One select over deployment sizes, each option with its compute unless `showCompute` is false. */
export function SizeSelect({
  id,
  value,
  tiers,
  onValueChange,
  disabled = false,
  describedBy,
  showCompute = true,
}: {
  id: string;
  value: InfrastructureSizeTier;
  tiers: readonly InfrastructureSizeTier[];
  onValueChange: (tier: InfrastructureSizeTier) => void;
  disabled?: boolean;
  /** The id of helper text that describes the select. */
  describedBy?: string;
  /** False shows the size name only, where the compute is shown beside the select. */
  showCompute?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(next) => onValueChange(next as InfrastructureSizeTier)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {tiers.map((tier) => (
          <SelectItem key={tier} value={tier}>
            {sizeTierLabel(tier)}
            {showCompute ? ` (${sizeTierCompute(tier)})` : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
