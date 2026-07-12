import { GoogleGenAI, Type } from "@google/genai";
import { PersonaType, Profile } from '../types';
import { COUNTRY_LIST } from '../constants';

const constructSystemInstruction = (type: PersonaType) => `
You are an expert creative writer generating profiles for applicants to an elite, long-duration project-based learning program.
These individuals have self-selected to be in the program. They are ambitious, high-agency change-makers who want to solve real problems.
You are generating profiles for a group identified as "${type}".

The tone should be:
- Ambitious and Action-Oriented: These are doers, not just dreamers.
- Vulnerable and real: They admit their failures and specific struggles. They have real faults, not the "humble-brag" sort.
- Diverse in origin, socioeconomic status, and life experience.
- English language output, but global representation.
- Use numbers, dates, and specific (but possibly artificial) proper names to give the profiles a real-world texture. Cite real sources of inspiration, real works of art, and actual real-world projects.

CRITICAL INSTRUCTION ON NAMES & DIVERSITY:
- You will be provided with a list of names to AVOID. Do not use them.
- Ensure unique first names and surnames.
- If a specific target country is provided in the prompt, you MUST use it.

CRITICAL INSTRUCTION ON REALISM & VERBOSITY:
- Real communities include people who are not strong writers, are shy, or simply unmotivated.
- You MUST simulate varying levels of engagement and literacy in the ANSWERS. Some typos will exist.
- "High Effort": Poetic, detailed, vulnerable, articulate (approx 40%).
- "Medium Effort": Conversational, standard sentences (approx 40%).
- "Low Effort/Reluctant": Short, abrupt, but still revealing of their character (approx 20%).
`;

const responseSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING },
      age: { type: Type.INTEGER },
      country: { type: Type.STRING },
      gender: { type: Type.STRING },
      bio: { type: Type.STRING },
      quotes: { 
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "3 distinct, short, punchy, representative quotes from this person that capture their essence or core beliefs." 
      },
      answers: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            question: { type: Type.STRING },
            answer: { type: Type.STRING }
          },
          required: ["question", "answer"]
        }
      },
    },
    required: ["name", "age", "country", "bio", "quotes", "answers"],
  },
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const generateProfilesBatch = async (
  type: PersonaType,
  count: number,
  questions: string[],
  existingNames: string[] = []
): Promise<Profile[]> => {
  if (!process.env.API_KEY) throw new Error("Gemini API Key is missing");

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  // FIX: Ensure seed is a standard 32-bit integer (max 2,147,483,647)
  // CONFIRMATION: This code executes freshly for every batch call, guaranteeing a new random seed per batch.
  const seed = Math.floor(Math.random() * 2000000000);

  // Entropy Injection: Pick random countries to force diversity
  const forcedCountries: string[] = [];
  for(let i=0; i<count; i++) {
    if (type === PersonaType.AmericanCollegeStudent) {
      // For American College Students, bias heavily towards US (80%) to represent native students
      if (Math.random() < 0.8) {
        forcedCountries.push("United States");
      } else {
        forcedCountries.push(COUNTRY_LIST[Math.floor(Math.random() * COUNTRY_LIST.length)]);
      }
    } else {
      forcedCountries.push(COUNTRY_LIST[Math.floor(Math.random() * COUNTRY_LIST.length)]);
    }
  }

  // Create a larger ban list to prevent repetition, slicing larger to keep context
  const banList = existingNames.slice(-300); 

  const prompt = `Task: Generate ${count} unique profiles for the persona type: "${type}".
  
  CONTEXT: These people are applying to join a community of change-makers. They want to learn and build projects.
  
  CONSTRAINT: DO NOT USE THESE NAMES: ${banList.join(", ")}.
  
  DIVERSITY INSTRUCTION: To ensure global representation, please try to use these specific countries for the ${count} profiles (one for each):
  ${forcedCountries.join(", ")}

  COMMUNICATION STYLE INSTRUCTION:
  - Within this batch of ${count}, ensure a MIX of communication styles in their ANSWERS.
  - Some should be very specific about the projects they want to build.
  - Others might be searching for purpose.
  
  The questions they must answer are:
  ${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}
  
  Ensure the "bio" is a rich narrative (approx 50-80 words) describing them.
  Ensure "quotes" is a list of exactly 3 distinct, interesting sentences that feel like something they would say.
  Vary the ages significantly within the group.`;

  let retries = 0;
  const maxRetries = 5;
  let delay = 4000; // Start with 4 seconds to be conservative with 429s

  while (retries <= maxRetries) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          systemInstruction: constructSystemInstruction(type),
          temperature: 1.7, // Lowered slightly from 1.85 to be safer, but still high for creativity
          responseMimeType: "application/json",
          responseSchema: responseSchema,
          seed: seed, 
        },
      });

      const rawData = JSON.parse(response.text || "[]");
      return rawData.map((p: any) => processProfileData(p, type));

    } catch (error: any) {
      // Analyze error for Rate Limits (429) or Service Overload (503)
      const errorMsg = error?.message || JSON.stringify(error);
      const isQuotaError = errorMsg.includes('429') || error?.status === 429 || error?.code === 429 || errorMsg.includes('RESOURCE_EXHAUSTED');
      const isServerOverload = errorMsg.includes('503') || error?.status === 503;

      if ((isQuotaError || isServerOverload) && retries < maxRetries) {
        console.warn(`Gemini API Quota/Limit Hit. Retrying in ${delay / 1000}s... (Attempt ${retries + 1}/${maxRetries})`);
        await sleep(delay);
        delay *= 2; // Exponential backoff: 4s -> 8s -> 16s...
        retries++;
      } else {
        console.error("Gemini Generation Fatal Error:", error);
        // If a batch fails fatally, return empty array so app can continue
        return [];
      }
    }
  }
  return [];
};

const processProfileData = (p: any, type: PersonaType): Profile => {
  const answersMap: Record<string, string> = {};
  
  if (p.answers && Array.isArray(p.answers)) {
    p.answers.forEach((item: any) => {
      if (item.question && item.answer) {
        answersMap[item.question] = item.answer;
      }
    });
  }

  return {
    id: crypto.randomUUID(),
    name: p.name || "Unknown",
    age: p.age || 0,
    country: p.country || "Unknown",
    gender: p.gender || "Unknown",
    type: type,
    bio: p.bio || "",
    quotes: Array.isArray(p.quotes) ? p.quotes : ["I am ready to learn."],
    answers: answersMap
  };
};