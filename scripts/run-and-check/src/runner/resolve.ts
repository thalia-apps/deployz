/**
 * A small resolver for the CloudFormation intrinsics that the compiler puts
 * into task-definition `Environment` and `Secrets`. It knows only `Ref`,
 * `Fn::GetAtt`, `Fn::Join` and the `{{resolve:secretsmanager:...}}` dynamic
 * reference. Any other intrinsic is an error: the harness must not guess.
 */

/** A reference to a resource the harness does not run (an SQS queue). */
export class UnresolvedReferenceError extends Error {
  constructor(readonly logicalId: string) {
    super(`no harness value for resource ${logicalId}`);
  }
}

export interface ResolveContext {
  /** `Ref` target: a parameter, `AWS::Region` or a resource. A secret resource resolves to its own logical id. */
  ref(name: string): string;
  getAtt(name: string, attribute: string): string;
  /** The value of one JSON field of a secret's `SecretString`. */
  secretField(secretId: string, field: string): string;
}

const DYNAMIC_REFERENCE = /\{\{resolve:secretsmanager:([A-Za-z0-9]+):SecretString:([A-Za-z0-9_]+)::\}\}/g;

function resolveNode(node: unknown, context: ResolveContext): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new Error(`cannot resolve ${JSON.stringify(node)}`);
  }
  const entries = Object.entries(node);
  if (entries.length !== 1) throw new Error(`cannot resolve ${JSON.stringify(node)}`);
  const [intrinsic, argument] = entries[0]!;
  switch (intrinsic) {
    case 'Ref':
      if (typeof argument !== 'string') throw new Error('Ref needs a name');
      return context.ref(argument);
    case 'Fn::GetAtt': {
      if (!Array.isArray(argument) || argument.length !== 2 || argument.some((part) => typeof part !== 'string')) {
        throw new Error('Fn::GetAtt needs [resource, attribute]');
      }
      return context.getAtt(argument[0] as string, argument[1] as string);
    }
    case 'Fn::Join': {
      if (!Array.isArray(argument) || argument.length !== 2 || typeof argument[0] !== 'string' || !Array.isArray(argument[1])) {
        throw new Error('Fn::Join needs [delimiter, [parts]]');
      }
      return (argument[1] as unknown[]).map((part) => resolveNode(part, context)).join(argument[0]);
    }
    default:
      throw new Error(`unsupported intrinsic ${intrinsic}`);
  }
}

/** Resolves a template value to a string, including `{{resolve:secretsmanager:...}}` references. */
export function resolveValue(node: unknown, context: ResolveContext): string {
  return resolveNode(node, context).replace(DYNAMIC_REFERENCE, (_match, secretId: string, field: string) =>
    context.secretField(secretId, field),
  );
}

const SECRET_VALUE_FROM = /^([A-Za-z0-9]+)(?::([A-Za-z0-9_]+)::)?$/;

/**
 * Resolves a task-definition secret `ValueFrom`: `<secret>` (the whole
 * `SecretString`) or `<secret>:<field>::` (one JSON field). `secretValue`
 * returns the `SecretString` of a secret resource, or one field of it.
 */
export function resolveSecretValueFrom(
  node: unknown,
  context: ResolveContext,
  secretValue: (secretId: string, field: string | null) => string,
): string {
  const text = resolveNode(node, context);
  const match = SECRET_VALUE_FROM.exec(text);
  if (match === null) throw new Error(`unsupported secret ValueFrom ${JSON.stringify(text)}`);
  return secretValue(match[1]!, match[2] ?? null);
}
