/**
 * 从 LLM 响应中提取 JSON 字符串
 * 兼容：有闭合 ```、无闭合 ```、纯 JSON、带前后文本等情况
 */
export function extractJsonFromResponse(response: string): string {
  const jsonMatch =
    response.match(/```json\s*([\s\S]*?)\s*```/) ||
    response.match(/```\s*([\s\S]*?)\s*```/) ||
    response.match(/```json\s*([\s\S]+)/) ||
    response.match(/```\s*([\s\S]+)/) ||
    [null, response];

  return (jsonMatch[1] || response).replace(/```\s*$/, "").trim();
}
