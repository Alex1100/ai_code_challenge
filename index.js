import * as xml2js from 'xml-js';
import * as dotenv from "dotenv";
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from "openai";
import waitOn from 'wait-on';
import { EPub } from 'epub2';
import { fileURLToPath } from 'url';
import { readPdfText } from 'pdf-text-reader';

// Load environment variables from .env file
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPEN_AI_API_KEY,
  organization: process.env.OPEN_AI_ORG_ID,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function extractPdfBook(fileName) {
  const pdfText = await readPdfText({url: path.join(__dirname, `${fileName}.pdf`)});
  fs.writeFile(path.join(__dirname, `${fileName}.txt`), pdfText, (err) => {
    if (err) {
      throw err;
    }
  });
};

async function parseXmlBook(fileName) {
  // Read XML file
  const data = await fs.readFileSync(path.join(__dirname, `${fileName}.xml`), 'utf8');

  // Convert XML to JSON
  const options = { compact: true, ignoreComment: true, textKey: 'text' };
  const result = xml2js.xml2js(data, options);

  // Extract text content
  const extractText = (obj) => {
    if (typeof obj === 'string') {
      return obj;
    } else if (Array.isArray(obj)) {
      return obj.map(extractText).join('');
    } else if (typeof obj === 'object') {
      return Object.values(obj).map(extractText).join('');
    }
    return '';
  };

  const text = extractText(result);
  fs.writeFile(path.join(__dirname, `${fileName}.txt`), text, (err) => {
    if (err) {
      throw err;
    }
  });
  return text;
}


async function extractEpubBook(fileName) {
  const franzFankaEpubPath = path.join(__dirname, `${fileName}.epub`);
  const epub = new EPub(franzFankaEpubPath);

  epub.on("end", function() {
    fs.writeFile(path.join(__dirname, `${fileName}.txt`), '', (err) => {
      if (err) {
        throw err;
      }
    });
    epub.flow.forEach(function(chapter) {
      epub.getChapter(chapter.id, function(err, text) {
        if (err) {
          throw err;
        }
        fs.appendFile(`${fileName}.txt`, text.replace(/<[^>]+>/g, ''), (err) => {
          if (err) {
            throw err;
          }
        });
      });
    });
  });
  
  epub.parse();
};

/**
 * This function chunks up a large input string into smaller chunks.
 */
const chunk = (s) => {
  let buf = Buffer.from(s);
  let maxBytes = 1000;
  const result = [];
  while (buf.length) {
      let i = buf.lastIndexOf(32, maxBytes+1);
      // If no space found, try forward search
      if (i < 0) i = buf.indexOf(32, maxBytes);
      // If there's no space at all, take the whole string
      if (i < 0) i = buf.length;
      // This is a safe cut-off point; never half-way a multi-byte
      result.push(buf.slice(0, i).toString());
      buf = buf.slice(i+1); // Skip space (if any)
  }
  return result;
}

async function generateBookSummary(filePath) {
  let file = await fs.readFileSync(filePath, 'utf-8');
  const uploadedFileChunked = chunk(file);
  const initialPrompt = `
    You are a helpful assistant.
    You will be summarizing a book which I will upload for you to analyze in chunks.
  `;
  const generateSummaryOfBookPrompt = `
    Summarize this book in at least 10,000 words
  `;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: initialPrompt },
      { role: 'user', content: `Do not respond until I tell you I am done uploading files. I will be splitting up files in chunks. The first book text content is the following.`},
      ...uploadedFileChunked.map(x => ({role: 'user', content: x})),
      { role: 'user', content: `The text content is done. I am done uploading text content.`},
      { role: 'user', content: generateSummaryOfBookPrompt },
    ]
  });
  
  const bookSummaryContent = completion.choices[0].message.content;
  fs.writeFile(`${filePath.split('.txt')[0]}_Summary.txt`, bookSummaryContent, (err) => {
    if (err) {
      throw err;
    }
  });
}

async function generateBookReport(filePaths) {
  let uploadedFiles = [];
  for (let idx in filePaths) {
    let filePath = filePaths[idx];
    let file = await fs.readFileSync(filePath, 'utf-8');
    uploadedFiles.push(file);
  }

  const uploadedFilesChunked = uploadedFiles.map(x => chunk(x));

  const initialPrompt = `
    You are a helpful assistant.
    The first ${filePaths.length} prompts you will get will be a series of long texts containing ${filePaths.length} books and their contents in text format.
    Please answer any questions and requests having in mind the contents of the ${filePaths.length} books from the first ${filePaths.length} prompts / uploaded text content.
  `;

  const generateReportPrompt = `
    Given the following previously uploaded files, your job is to ingest the text from each book uploaded from these files I uploaded and comparatively analyze how each work deals with the theme of social isolation.
    What are the authors’ points of view on this subject, and what parts of the novel corroborate these claims?
    
    Your output will be a 5 paragraph book report of roughly 500 - 800 words in total length that states a clear thesis statement, makes clear arguments based on the content of each novel, and accurately cites sections of each novel, culminating in a concluding paragraph to summarize the arguments.
    A five paragraph essay has one introduction, three body paragraphs, and one conclusion.
    For academic writing, paragraphs are usually 100–200 words long.
    Please follow this standard and make sure that the book report you create follows this format of a five paragraph essay and has 100-200 words per paragraph at least.
    Finally, Please provide sources for the following points you try to make by using citations.
  `;

  const prompts = uploadedFilesChunked.flatMap((chunks, idx) => {
    return [...chunks.map(chunk => ({ role: 'user', content: chunk })), { role: 'user', content: `Book Summary # ${idx + 1} text content is done uploading. ${idx === uploadedFilesChunked.length - 1 ? '' : 'I will now upload the text content for Book # ' + (idx + 2) + '.'}`}]
  });

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: initialPrompt },
      { role: 'user', content: `Do not respond until I tell you I am done uploading files. I will be splitting up files in chunks. The first book text content is the following.`},
      ...prompts,
      { role: 'user', content: `The text content is done. I am done uploading text content.`},
      { role: "user", content: generateReportPrompt }
    ]
  });

  const bookReportContent = completion.choices[0].message.content;
  fs.writeFile(path.join(__dirname, `BookReport_${Date.now()}.txt`), bookReportContent, (err) => {
    if (err) {
      throw err;
    }
  });
}

/**
 * This function will check if we need to create a .txt file of a given file.
 * This function has the capacity to parse XML, PDF, and Epub file formtats into a .txt file
 * 
 * Once it does that, we will then feed those .txt files into gpt-4o-mini and generate Summaries
 * for the target file / book.
 */
const waitOnSummary = async (fileName) => {
  try {
    const fileList = await fs.readdirSync(__dirname);
    const fileFound = fileList.filter(file => file.indexOf(fileName) >= 0);
    const isFileInCwd = fileFound.length > 0;

    if (!isFileInCwd) {
      throw new Error(`File: ${fileName} is not found.`);
    }

    if (!fileList.some(file => file === fileName + '.txt')) {
      const fileType = path.extname(fileFound[0]);

      switch(fileType) {
        case '.epub':
          await extractEpubBook(fileName);
          break;
        case '.pdf':
          await extractPdfBook(fileName);
          break;
        case '.xml':
          await parseXmlBook(fileName);
          break;
        default:
          return;
      }
    }

    waitOn({ resources: [`${fileName}.txt`] }).then(async () => {
      if (!fileList.some(file => file === fileName + '_Summary.txt')) {
        await generateBookSummary(path.join(__dirname, `${fileName}.txt`));
      }
    });
  } catch (e) {
    console.error(e);
  }
};

const waitOnBookReport = async (resources) => {
  try {
    waitOn({ resources }).then(async () => {
      await generateBookReport(resources.map(resource => path.join(__dirname, resource)));
    });
  } catch (e) {
    console.error(e);
  }
};

/**
 * What this program does is it will go through each book and convert it into a .txt file.
 * Then each .txt file for each book will be fed into OpenAI's gpt-4o-mini LLM to create
 * a summary.
 * 
 * Once we have a summary for each book, we will then add all of those to our list of prompts into a new
 * completion and generate a book report for all of the books.
 */
const main = async () => {
  const filesList = await fs.readdirSync(__dirname);

  if (!filesList.some(file => file === 'the_stranger_Summary.txt')) {
    await waitOnSummary('the_stranger');
  }
  if (!filesList.some(file => file === 'The-Bell-Jar-1645639705._vanilla_Summary.txt')) {
    await waitOnSummary('The-Bell-Jar-1645639705._vanilla');
  }
  if (!filesList.some(file => file === 'franz-kafka_metamorphosis_Summary.txt')) {
    await waitOnSummary('franz-kafka_metamorphosis');
  }
  await waitOnBookReport([
    'The-Bell-Jar-1645639705._vanilla_Summary.txt',
    'franz-kafka_metamorphosis_Summary.txt',
    'the_stranger_Summary.txt',
  ]);
};

main();