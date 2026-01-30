import { defineTool, type ToolResultObject } from "@github/copilot-sdk";
import axios from "axios";
import { resolveSettings } from "../lib/settings.js";

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

// Extract plain text content from Notion API blocks response
function extractNotionTextContent(notionResponse: any): string {
  if (!notionResponse?.results || !Array.isArray(notionResponse.results)) {
    return "No content found in Notion response.";
  }

  const textParts: string[] = [];

  for (const block of notionResponse.results) {
    if (!block.type) continue;

    let blockText = "";
    
    // Handle different block types that contain rich_text
    const blockData = block[block.type];
    if (blockData?.rich_text && Array.isArray(blockData.rich_text)) {
      // Extract plain_text from each rich_text element
      const richTexts = blockData.rich_text
        .map((richText: any) => richText.plain_text || "")
        .filter((text: string) => text.length > 0);
      
      blockText = richTexts.join("");
    }

    // Add formatting based on block type
    if (blockText.trim()) {
      switch (block.type) {
        case "heading_1":
          textParts.push(`\n# ${blockText}\n`);
          break;
        case "heading_2":
          textParts.push(`\n## ${blockText}\n`);
          break;
        case "heading_3":
          textParts.push(`\n### ${blockText}\n`);
          break;
        case "paragraph":
          textParts.push(blockText);
          break;
        default:
          textParts.push(blockText);
          break;
      }
    } else if (block.type === "paragraph") {
      // Empty paragraphs create line breaks
      textParts.push("\n");
    }
  }

  return textParts.join("").trim();
}

export const servicePricingLookupTool = defineTool("servicePricingLookupTool", {
  description: "Retreive the service pricing list from Notion in the form of plain text.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  handler: async (args): Promise<ToolResultObject> => {

    if (DEBUG_MODE) {
      console.log('[servicePricingLookupTool] invoked with args:', args);
    }

    const { notionApiKey: NOTION_API_KEY, notionPageId: NOTION_PAGE_ID } = await resolveSettings();

    if (!NOTION_PAGE_ID || !NOTION_API_KEY) {
      const msg = "Notion credentials (NOTION_PAGE_ID / NOTION_API_KEY) are not configured in the environment.";
      if (DEBUG_MODE) {
        console.warn("[servicePricingLookupTool]", msg);
      }
      return { textResultForLlm: msg, resultType: "failure" };
    }

    const apiUrl = `https://api.notion.com/v1/blocks/${NOTION_PAGE_ID}/children`;
    const headers = {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    };

    try {
      if (DEBUG_MODE) {
        console.log(`[servicePricingLookupTool] fetching Notion blocks for page ${NOTION_PAGE_ID}`);
      }
      const resp = await axios.get(apiUrl, { headers });
      if (DEBUG_MODE) {
        console.log(`[servicePricingLookupTool] response status ${resp.status}`);
      }
      const data = resp.data;

      // Extract clean text content from the Notion response
      const textContent = extractNotionTextContent(data);

      return {
        textResultForLlm: `Tom Shaw's Pricing Information:\n\n${textContent}`,
        resultType: "success",
      };
    } catch (error) {
      const status = axios.isAxiosError(error) && error.response ? error.response.status : "n/a";
      const body = axios.isAxiosError(error) && error.response ? JSON.stringify(error.response.data) : String(error);
      if (DEBUG_MODE) {
        console.error("[servicePricingLookupTool] error fetching Notion data:", status, body);
      }
      return {
        textResultForLlm: `Failed to fetch pricing data from Notion: ${status} - ${body}`,
        resultType: "failure",
      };
    }
  },
});

export const currencyConversionTool = defineTool<{
  amount: number;
  fromCurrency: string;
  toCurrency: string;
}>("convert_currency", {
  description: "Convert an amount from one currency to another.",
  parameters: {
    type: "object",
    properties: {
      amount: {
        type: "number",
        description: "The amount of money to convert.",
      },
      fromCurrency: {
        type: "string",
        description: "The currency code to convert from (e.g., USD).",
      },
      toCurrency: {
        type: "string",
        description: "The currency code to convert to (e.g., EUR).",
      },
    },
    required: ["amount", "fromCurrency", "toCurrency"],
  },
  handler: async (args): Promise<ToolResultObject> => {
    const { amount, fromCurrency, toCurrency } = args;
    const { exchangeRateApiKey } = await resolveSettings();

    if (!exchangeRateApiKey) {
      return {
        textResultForLlm:
          "EXCHANGE_RATE_API_KEY is not configured. Run /settings to add it.",
        resultType: "failure",
      };
    }

    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    try {
      const apiUrl = `https://v6.exchangerate-api.com/v6/${exchangeRateApiKey}/pair/${from}/${to}`;
      const resp = await axios.get(apiUrl);
      const data = resp.data;

      if (!data || data.result !== "success" || typeof data.conversion_rate !== "number") {
        return {
          textResultForLlm: `Exchange rate API error: ${JSON.stringify(data)}`,
          resultType: "failure",
        };
      }

      const convertedAmount = amount * data.conversion_rate;

      return {
        textResultForLlm: `Converted amount: ${convertedAmount.toFixed(2)} ${to}`,
        resultType: "success",
      };
    } catch (error) {
      return {
        textResultForLlm: `Error during currency conversion: ${String(error)}`,
        resultType: "failure",
      };
    }
  },
});
