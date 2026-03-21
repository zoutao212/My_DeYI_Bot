// SafeW API 测试脚本
// 用法: node test-safew-api.js <token> [api-base-url]

const token = process.argv[2] || "12625139:3AODx49KzsDagSKWgcbzIO7GowrQ3KPMjhp";
const apiBase = process.argv[3] || "https://api.safew.org";

console.log("测试 SafeW API 连接...");
console.log("Token:", token);
console.log("API Base:", apiBase);
console.log("");

// 测试不同的 URL 格式
const urlFormats = [
  `${apiBase}/${token}/getMe`,           // 格式 1: /<token>/getMe
  `${apiBase}/bot${token}/getMe`,        // 格式 2: /bot<token>/getMe
  `${apiBase}/api/${token}/getMe`,       // 格式 3: /api/<token>/getMe
  `${apiBase}/v1/${token}/getMe`,        // 格式 4: /v1/<token>/getMe
];

async function testUrl(url, index) {
  console.log(`[${index + 1}] 测试: ${url}`);
  try {
    const response = await fetch(url);
    const text = await response.text();
    
    console.log(`    状态码: ${response.status} ${response.statusText}`);
    
    if (response.ok) {
      try {
        const json = JSON.parse(text);
        console.log(`    ✅ 成功! Bot 信息:`, JSON.stringify(json, null, 2));
        return true;
      } catch {
        console.log(`    响应内容:`, text.substring(0, 200));
      }
    } else {
      console.log(`    ❌ 失败:`, text.substring(0, 200));
    }
  } catch (error) {
    console.log(`    ❌ 错误:`, error.message);
  }
  console.log("");
  return false;
}

async function main() {
  for (let i = 0; i < urlFormats.length; i++) {
    const success = await testUrl(urlFormats[i], i);
    if (success) {
      console.log("找到正确的 URL 格式！");
      process.exit(0);
    }
  }
  
  console.log("所有格式都失败了。请检查：");
  console.log("1. Token 是否正确");
  console.log("2. API Base URL 是否正确");
  console.log("3. 网络连接是否正常");
  console.log("");
  console.log("你可以尝试不同的 API Base URL:");
  console.log("  node test-safew-api.js <token> https://api.safew.com");
  console.log("  node test-safew-api.js <token> https://safew.org/api");
  console.log("  node test-safew-api.js <token> https://bot.safew.org");
}

main().catch(console.error);
