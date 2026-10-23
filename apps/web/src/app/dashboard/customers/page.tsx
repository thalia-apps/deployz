'use client';

import { Eye, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { DeleteCustomerDialog } from '@/components/delete-customer-dialog';
import { DocsLink } from '@/components/docs-link';
import { EditCustomerDialog } from '@/components/edit-customer-dialog';
import { ListLoadingState, ListSearchInput, NoMatchesState, SortableHead } from '@/components/list-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  CUSTOMER_SORT_NATURAL,
  CUSTOMER_STATE_FILTERS,
  CUSTOMER_STATE_FILTER_LABELS,
  DEFAULT_CUSTOMER_SORT,
  customerListRow,
  deploymentsByCustomer,
  fetchCustomers,
  filterCustomerRows,
  formatDate,
  hasActiveCustomerFilters,
  parseCustomerQuery,
  singleDeploymentDestination,
  sortCustomerRows,
  type Customer,
  type CustomerDeployment,
  type CustomerListRow,
  type CustomerSortKey,
} from '@/lib/customers';
import { CUSTOMER_BUCKET_BADGE } from '@/lib/deployment-status-groups';
import { fetchDeployments, type FleetDeployment } from '@/lib/deployments';
import { relativeTime } from '@/lib/diagnostics';
import { DOCS } from '@/lib/docs-links';
import { formatDateTime, nextSort, sortParams, type SortState } from '@/lib/list-view';
import { useListParams } from '@/lib/use-list-params';

// The Customers screen answers: who are my customers, and which relationships
// need attention? One row per customer. The deployment column is a
// customer-level summary counted from that customer's deployments
// (lib/deployment-status-groups) — never one deployment's status standing in
// for the rest, and never a raw AWS status. Search, filters and sorting are
// client-side over the rows the table already has — the fleet a vendor manages
// is small, and a round trip per keystroke would make the screen feel slower,
// not faster — and live in the URL so Back restores the view.

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; customers: Customer[]; deployments: FleetDeployment[] };

export default function CustomersPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  const { params, setParams } = useListParams();
  const parsed = useMemo(() => parseCustomerQuery(params), [params]);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        // Deployments come from the same fleet endpoint the Deployments list
        // uses, so the status shown here is the server-derived one — the two
        // screens can never disagree about a customer's deployment.
        const [customers, deployments] = await Promise.all([
          fetchCustomers(),
          fetchDeployments({ includeDeleted: true }),
        ]);
        if (!cancelled) setState({ status: 'loaded', customers, deployments });
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: "Couldn't load customers. Try again.",
          });
        }
      } finally {
        if (!cancelled) setRetrying(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const customers = useMemo(() => (state.status === 'loaded' ? state.customers : []), [state]);
  const allRows = useMemo(() => {
    const grouped = deploymentsByCustomer(state.status === 'loaded' ? state.deployments : []);
    return customers.map((customer) => customerListRow(customer, grouped.get(customer.id) ?? []));
  }, [state, customers]);

  const applications = useMemo(
    () => [...new Set(allRows.flatMap((row) => row.applications))].sort(),
    [allRows],
  );

  // A link naming an application this fleet no longer has would filter to
  // nothing behind a blank select, so it is treated as "all".
  const query = useMemo(
    () => ({
      ...parsed,
      application:
        parsed.application !== null && applications.includes(parsed.application)
          ? parsed.application
          : null,
    }),
    [parsed, applications],
  );

  const rows = useMemo(
    () => sortCustomerRows(filterCustomerRows(allRows, query), query.sort),
    [allRows, query],
  );
  const filtersActive = hasActiveCustomerFilters(query);

  function clearFilters(): void {
    setParams({ q: null, state: null, application: null });
  }

  function onSort(key: CustomerSortKey): void {
    setParams(sortParams(nextSort(query.sort, key, CUSTOMER_SORT_NATURAL), DEFAULT_CUSTOMER_SORT));
  }

  function applySaved(saved: Customer): void {
    setState((current) =>
      current.status === 'loaded'
        ? {
            ...current,
            customers: current.customers.map((customer) =>
              customer.id === saved.id ? saved : customer,
            ),
          }
        : current,
    );
  }

  function applyDeleted(customerId: string): void {
    setState((current) =>
      current.status === 'loaded'
        ? {
            ...current,
            customers: current.customers.filter((customer) => customer.id !== customerId),
          }
        : current,
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <DocsLink href={DOCS.customerStatuses}>What each status means</DocsLink>
        </div>
        {state.status === 'loaded' && customers.length === 0 ? null : (
          <Button asChild size="sm">
            <Link href="/dashboard/deployments/new">Invite customer</Link>
          </Button>
        )}
      </div>

      {state.status === 'loading' ? <ListLoadingState testId="customers-loading" /> : null}
      {state.status === 'error' ? (
        <ErrorState
          message={state.message}
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            setAttempt((n) => n + 1);
          }}
        />
      ) : null}

      {state.status === 'loaded' ? (
        customers.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <ListSearchInput
                value={query.search}
                onCommit={(value) => setParams({ q: value })}
                placeholder="Search customers"
                label="Search customers"
              />
              <Select
                value={query.state ?? 'all'}
                onValueChange={(value) => setParams({ state: value === 'all' ? null : value })}
              >
                <SelectTrigger aria-label="Filter by deployment state" className="w-full sm:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All deployment states</SelectItem>
                  {CUSTOMER_STATE_FILTERS.map((filter) => (
                    <SelectItem key={filter} value={filter}>
                      {CUSTOMER_STATE_FILTER_LABELS[filter]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {applications.length > 1 ? (
                <Select
                  value={query.application ?? 'all'}
                  onValueChange={(value) =>
                    setParams({ application: value === 'all' ? null : value })
                  }
                >
                  <SelectTrigger aria-label="Filter by application" className="w-full sm:w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All applications</SelectItem>
                    {applications.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {filtersActive ? (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null}
              <p className="text-sm text-muted-foreground sm:ml-auto" data-testid="customer-count">
                {rows.length} of {customers.length}{' '}
                {customers.length === 1 ? 'customer' : 'customers'}
              </p>
            </div>

            {rows.length === 0 ? (
              <NoMatchesState heading="No customers match these filters." onClear={clearFilters} />
            ) : (
              <CustomerTable
                rows={rows}
                activeSort={query.sort}
                onSort={onSort}
                onEdit={setEditing}
                onDelete={setDeleting}
              />
            )}
          </>
        )
      ) : null}

      {editing ? (
        <EditCustomerDialog
          customer={editing}
          open
          onOpenChange={(open) => (open ? undefined : setEditing(null))}
          onSaved={applySaved}
        />
      ) : null}
      {deleting ? (
        <DeleteCustomerDialog
          customer={deleting}
          open
          onOpenChange={(open) => (open ? undefined : setDeleting(null))}
          onDeleted={applyDeleted}
        />
      ) : null}
    </div>
  );
}

function CustomerTable({
  rows,
  activeSort,
  onSort,
  onEdit,
  onDelete,
}: {
  rows: CustomerListRow[];
  activeSort: SortState<CustomerSortKey>;
  onSort: (key: CustomerSortKey) => void;
  onEdit: (customer: Customer) => void;
  onDelete: (customer: Customer) => void;
}) {
  const direction = (key: CustomerSortKey) => (activeSort.key === key ? activeSort.dir : null);
  return (
    // A container query, not a viewport one: the sidebar takes 256px at
    // tablet widths, so the table's own width says how many columns fit.
    <Card className="@container py-0">
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="customer-list">
          <TableHeader>
            <TableRow>
              <SortableHead label="Customer" direction={direction('customer')} onSort={() => onSort('customer')} />
              <TableHead className="hidden @4xl:table-cell">Applications</TableHead>
              <TableHead>Deployment summary</TableHead>
              <SortableHead
                label="Last activity"
                direction={direction('activity')}
                onSort={() => onSort('activity')}
                className="hidden @2xl:table-cell"
              />
              {/* Created is the first thing to go when the table narrows —
                  it is the least useful column for deciding what to do next. */}
              <SortableHead
                label="Created"
                direction={direction('created')}
                onSort={() => onSort('created')}
                className="hidden @4xl:table-cell"
              />
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <CustomerRow key={row.customer.id} row={row} onEdit={onEdit} onDelete={onDelete} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function CustomerRow({
  row,
  onEdit,
  onDelete,
}: {
  row: CustomerListRow;
  onEdit: (customer: Customer) => void;
  onDelete: (customer: Customer) => void;
}) {
  const { customer, summary, applications, rollup, lastActivityAt } = row;
  return (
    <TableRow>
      <TableCell>
        <Link
          href={`/dashboard/customers/${customer.id}`}
          title={customer.name}
          className="block max-w-28 truncate font-medium hover:underline @sm:max-w-56"
        >
          {customer.name}
        </Link>
        <p
          className="max-w-28 truncate text-xs text-muted-foreground @sm:max-w-56"
          title={customer.company ? `${customer.email} · ${customer.company}` : customer.email}
        >
          {customer.email}
        </p>
      </TableCell>
      <TableCell className="hidden @4xl:table-cell">
        <ApplicationsCell names={applications} />
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="customer-summary">
          {summary.parts.map((part) => (
            <Badge key={part.text} variant={CUSTOMER_BUCKET_BADGE[part.bucket]}>
              {part.text}
            </Badge>
          ))}
        </div>
        {/* Last activity is a column only when the table is wide enough. */}
        <p className="mt-1 text-xs text-muted-foreground @2xl:hidden" data-testid="customer-activity">
          {relativeTime(lastActivityAt) ?? '—'}
        </p>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-muted-foreground @2xl:table-cell">
        {/* data-testid: masked in visual regression — relative time drifts
            with the clock. */}
        <time dateTime={lastActivityAt} title={formatDateTime(lastActivityAt)} data-testid="customer-activity">
          {relativeTime(lastActivityAt) ?? '—'}
        </time>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-muted-foreground @4xl:table-cell">
        {formatDate(customer.createdAt)}
      </TableCell>
      <TableCell className="w-10">
        <RowActions customer={customer} rollup={rollup} onEdit={onEdit} onDelete={onDelete} />
      </TableCell>
    </TableRow>
  );
}

// The first application by name, then a "+N" for the rest — the full list is
// in the tooltip and read out for screen readers, so a customer on many
// applications never widens the row.
function ApplicationsCell({ names }: { names: string[] }) {
  const [first, ...rest] = names;
  if (first === undefined) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex items-center gap-1.5 text-muted-foreground">
      <span className="max-w-40 truncate" title={names.join(', ')}>
        {first}
      </span>
      {rest.length > 0 ? (
        <Badge variant="secondary" title={names.join(', ')}>
          +{rest.length}
          <span className="sr-only"> more: {rest.join(', ')}</span>
        </Badge>
      ) : null}
    </div>
  );
}

// Only actions this row's data actually supports: no install link without a
// deployment to install, no "View deployment" without one destination, and no
// Delete for a customer the API would refuse anyway.
function RowActions({
  customer,
  rollup,
  onEdit,
  onDelete,
}: {
  customer: Customer;
  rollup: CustomerDeployment;
  onEdit: (customer: Customer) => void;
  onDelete: (customer: Customer) => void;
}) {
  const destination = singleDeploymentDestination(rollup);
  const deletable = rollup.deployments.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${customer.name}`}
          className="ml-auto"
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {destination ? (
          <DropdownMenuItem asChild>
            <Link href={`/dashboard/deployments/${destination.id}`}>
              <Eye aria-hidden />
              View deployment
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => onEdit(customer)}>
          <Pencil aria-hidden />
          Edit customer
        </DropdownMenuItem>
        {deletable ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(customer)}>
              <Trash2 aria-hidden />
              Delete customer
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ErrorState({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <section
      aria-labelledby="customers-error"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="customers-error" className="text-lg font-semibold">
        Something went wrong
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" loading={retrying} loadingText="Trying again…" onClick={onRetry}>
        Try again
      </Button>
    </section>
  );
}

function EmptyState() {
  return (
    <section
      aria-labelledby="empty-customers"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="empty-customers" className="text-lg font-semibold">
        Add your first customer
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Send a secure link to deploy your application into their AWS account.
      </p>
      <Button asChild>
        <Link href="/dashboard/deployments/new">Invite customer</Link>
      </Button>
    </section>
  );
}
