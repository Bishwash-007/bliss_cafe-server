import type {
  Report,
  ReportBody,
  ReportLifecycleHooks,
  ReportStep,
} from '../reporting.types';
import { ReportGenerator } from './report-generator';

class ProbeGenerator extends ReportGenerator<string> {
  constructor(hooks: ReportLifecycleHooks = {}) {
    super(hooks);
  }

  protected fetchData(): Promise<string> {
    return Promise.resolve('raw');
  }

  protected aggregate(data: string): ReportBody {
    return {
      type: 'probe',
      title: 'Probe report',
      branchId: null,
      range: null,
      summary: { fetched: data },
      tables: [
        {
          key: 'rows',
          title: 'Rows',
          columns: [
            { key: 'name', label: 'Name' },
            { key: 'value', label: 'Value' },
          ],
          rows: [{ name: 'a', value: 1 }],
          totals: { name: 'TOTAL', value: 1 },
        },
      ],
    };
  }
}

/** A subclass that tries to replace the orchestration with its own method. */
class MethodOverrideAttempt extends ProbeGenerator {
  // @ts-expect-error `generate` is an instance property, not an overridable method.
  override generate(_type?: 'csv' | 'pdf'): Promise<Report> {
    return Promise.resolve({ type: 'hijacked' } as Report);
  }
}

/** A subclass that tries to replace the orchestration with a class field. */
class FieldOverrideAttempt extends ProbeGenerator {
  generate = (): Promise<Report> =>
    Promise.resolve({ type: 'hijacked' } as Report);
}

describe('ReportGenerator template method', () => {
  it('runs fetch -> aggregate -> format -> export, in that order', async () => {
    const steps: ReportStep[] = [];
    const generator = new ProbeGenerator({
      onStep: (step) => steps.push(step),
    });

    const report = await generator.generate();

    expect(steps).toEqual(['fetch', 'aggregate', 'format', 'export']);
    expect(report.type).toBe('probe');
    expect(report.summary).toEqual({ fetched: 'raw' });
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.export.type).toBe('csv');
    expect(report.export.content).toContain('Probe report');
  });

  it('passes the requested export type to the export step', async () => {
    const steps: ReportStep[] = [];
    const generator = new ProbeGenerator({
      onStep: (step) => steps.push(step),
    });

    const report = await generator.generate('pdf');

    expect(steps).toEqual(['fetch', 'aggregate', 'format', 'export']);
    expect(report.export.type).toBe('pdf');
    expect(report.export.contentType).toBe('application/pdf');
    expect(report.export.encoding).toBe('base64');
    expect(Buffer.from(report.export.content, 'base64').subarray(0, 5)).toEqual(
      Buffer.from('%PDF-'),
    );
  });

  it('ignores a subclass method that tries to take over generate()', async () => {
    const steps: ReportStep[] = [];
    const generator = new MethodOverrideAttempt({
      onStep: (step) => steps.push(step),
    });

    const report = await generator.generate();

    expect(steps).toEqual(['fetch', 'aggregate', 'format', 'export']);
    expect(report.type).toBe('probe');
  });

  it('refuses a subclass field that tries to replace generate()', () => {
    expect(() => new FieldOverrideAttempt()).toThrow(TypeError);
  });

  it('makes the orchestration properties non-configurable', () => {
    const generator = new ProbeGenerator();

    for (const property of ['generate', 'format', 'export'] as const) {
      expect(() =>
        Object.defineProperty(generator, property, {
          value: () => undefined,
        }),
      ).toThrow(TypeError);
    }
  });

  it('rejects an aggregate body with duplicate table keys', async () => {
    class DuplicateTableGenerator extends ProbeGenerator {
      protected override aggregate(data: string): ReportBody {
        const body = super.aggregate(data);
        return {
          ...body,
          tables: [body.tables[0], body.tables[0]],
        };
      }
    }

    await expect(new DuplicateTableGenerator().generate()).rejects.toThrow(
      'Duplicate report table key',
    );
  });
});
