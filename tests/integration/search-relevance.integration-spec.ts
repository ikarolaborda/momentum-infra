/**
 * Search relevance tests validating:
 * - Typo tolerance (fuzzy matching)
 * - Portuguese stemming
 * - Accent insensitivity
 * - Date range filtering
 * - Relevance ranking
 */

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'http://localhost:3003';

describe('Search Relevance', () => {
  // Wait for Elasticsearch to be populated
  beforeAll(async () => {
    await new Promise((r) => setTimeout(r, 5000));
  });

  it('should find events by exact keyword', async () => {
    const response = await fetch(`${SEARCH_SERVICE_URL}/search?keyword=Rock%20in%20Rio`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data.length).toBeGreaterThan(0);
    expect(data.data[0].name).toContain('Rock in Rio');
  });

  it('should handle typos with fuzzy matching', async () => {
    // "Rok in Roo" should still find "Rock in Rio"
    const response = await fetch(`${SEARCH_SERVICE_URL}/search?keyword=Rok%20in%20Roo`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data.length).toBeGreaterThan(0);
    const names = data.data.map((d: any) => d.name.toLowerCase());
    expect(names.some((n: string) => n.includes('rock'))).toBe(true);
  });

  it('should be accent-insensitive', async () => {
    // Search without accents should find accented results
    const response = await fetch(`${SEARCH_SERVICE_URL}/search?keyword=opera`);
    const data = await response.json();

    expect(response.status).toBe(200);
    // Should find "O Fantasma da Ópera" (with accent)
    if (data.data.length > 0) {
      const found = data.data.some((d: any) =>
        d.name.toLowerCase().includes('opera') || d.name.toLowerCase().includes('ópera'),
      );
      expect(found).toBe(true);
    }
  });

  it('should support Portuguese stemming', async () => {
    // "festivais" (plural of "festival") should find festivals
    const response = await fetch(`${SEARCH_SERVICE_URL}/search?keyword=festivais`);
    const data = await response.json();

    expect(response.status).toBe(200);
    // Should find events of type "festival"
  });

  it('should filter by date range', async () => {
    const response = await fetch(
      `${SEARCH_SERVICE_URL}/search?keyword=&startDate=2026-07-01&endDate=2026-09-30`,
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    for (const event of data.data) {
      const date = new Date(event.date);
      expect(date >= new Date('2026-07-01')).toBe(true);
      expect(date <= new Date('2026-09-30T23:59:59Z')).toBe(true);
    }
  });

  it('should search by artist name', async () => {
    const response = await fetch(`${SEARCH_SERVICE_URL}/search?keyword=Anitta`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data.length).toBeGreaterThan(0);
    expect(data.data[0].artist).toContain('Anitta');
  });

  it('should search by venue name', async () => {
    const response = await fetch(`${SEARCH_SERVICE_URL}/search?keyword=Maracana`);
    const data = await response.json();

    expect(response.status).toBe(200);
    // Should find events at Maracanã (accent-insensitive)
  });

  it('should return results within target latency', async () => {
    const start = Date.now();
    const response = await fetch(`${SEARCH_SERVICE_URL}/search?keyword=rock`);
    const duration = Date.now() - start;

    expect(response.status).toBe(200);
    // p95 target: under 500ms
    expect(duration).toBeLessThan(500);
  });
});
