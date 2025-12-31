// Configuration
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let extractedData = [];    // The main data array
let imageMemoryMap = {};   // Stores filename -> BlobURL for the flashcards
let currentStudentList = []; // The "working copy" for the flashcard deck
let zip = new JSZip();

// --- STEP 2: PDF EXTRACTION LOGIC ---

document.getElementById('pdf-upload').addEventListener('change', async (e) => {
    // TRIGGER THE RESET FIRST
    resetAppState();

    const file = e.target.files[0];
    if (!file) return;

    const status = document.getElementById('status');
    status.innerText = "Processing PDF and extracting photos...";

    const reader = new FileReader();
    reader.onload = async function() {
        try {
            const typedarray = new Uint8Array(this.result);
            const pdf = await pdfjsLib.getDocument(typedarray).promise;
            
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const items = textContent.items;

                // 1. Identify Name Font Size (Baseline)
                const classItem = items.find(item => item.str.includes("Classification"));
                const detailFontSize = classItem ? classItem.height : 10;
                const nameThreshold = detailFontSize * 1.1; 

                let currentNameParts = [];
                let pageNames = [];

                // 2. Filter items to isolate names
                for (let j = 0; j < items.length; j++) {
                    const item = items[j];
                    const text = item.str.trim();

                    if (text.includes("Classification:")) {
                        if (currentNameParts.length > 0) {
                            pageNames.push(currentNameParts.join(" ").trim());
                            currentNameParts = [];
                        }
                    } else if (item.height >= nameThreshold && text.length > 1) {
                        currentNameParts.push(text);
                    }
                }

                // 3. Image Extraction
                const ops = await page.getOperatorList();
                let imgCount = 0;
                
                for (let j = 0; j < ops.fnArray.length; j++) {
                    if (ops.fnArray[j] === pdfjsLib.OPS.paintImageXObject) {
                        if (pageNames[imgCount]) {
                            const cleanName = pageNames[imgCount];
                            const fileName = sanitizeName(cleanName) + ".jpg";
                            const imgKey = ops.argsArray[j][0];
                            
                            try {
                                const image = await page.objs.get(imgKey);
                                const canvas = document.createElement('canvas');
                                canvas.width = image.width;
                                canvas.height = image.height;
                                const ctx = canvas.getContext('2d');

                                // Handle decoding to avoid 'black boxes'
                                if (image.bitmap) {
                                    ctx.drawImage(image.bitmap, 0, 0);
                                } else {
                                    const imgData = ctx.createImageData(image.width, image.height);
                                    if (image.data.length === imgData.data.length) {
                                        imgData.data.set(image.data);
                                    } else {
                                        for (let k = 0, l = 0; k < imgData.data.length; k += 4, l += 3) {
                                            imgData.data[k] = image.data[l];
                                            imgData.data[k+1] = image.data[l+1];
                                            imgData.data[k+2] = image.data[l+2];
                                            imgData.data[k+3] = 255;
                                        }
                                    }
                                    ctx.putImageData(imgData, 0, 0);
                                }

                                const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95));
                                
                                // Save to ZIP
                                zip.file(fileName, blob);
                                
                                // Save to Memory for Step 3 (Flashcards)
                                const blobUrl = URL.createObjectURL(blob);
                                imageMemoryMap[fileName] = blobUrl;

                                extractedData.push({
                                    name: cleanName,
                                    headshot: fileName
                                });
                            } catch (e) { console.error("Img error:", e); }
                        }
                        imgCount++;
                    }
                }
            }

            updateDisplay();
            status.innerHTML = `<span class="text-success fw-bold"><i class="bi bi-check-circle"></i> Success! Extracted ${extractedData.length} students.</span>`;

        } catch (err) {
            console.error(err);
            status.innerText = "Process failed. Check console.";
        }
    };
    reader.readAsArrayBuffer(file);
});

// --- STEP 3: FLASHCARD LOGIC ---

document.getElementById('load-from-step2').addEventListener('click', function() {
    if (extractedData.length === 0) {
        alert("Please complete Step 2 (PDF Extraction) first!");
        return;
    }

    currentStudentList = [...extractedData];
    this.classList.add('d-none');
    document.getElementById('shuffle-cards').classList.remove('d-none');
    document.getElementById('card-counter').classList.remove('d-none');
    
    renderFlashcards(currentStudentList);
    updateCounter();
});

document.getElementById('shuffle-cards').addEventListener('click', function() {
    const shuffled = shuffleArray([...currentStudentList]);
    renderFlashcards(shuffled);
});

function renderFlashcards(students) {
    const container = document.getElementById('flashcard-container');
    container.innerHTML = ''; 

    students.forEach((student, index) => {
        const imgSrc = imageMemoryMap[student.headshot] || 'https://via.placeholder.com/250x350';
        const cardHTML = `
            <div class="col-auto mb-4" id="student-card-${index}">
                <div class="flashcard-wrapper" onclick="this.querySelector('.flashcard').classList.toggle('is-flipped')">
                    <div class="flashcard">
                        <div class="flashcard-front">
                            <img src="${imgSrc}" alt="${student.name}">
                        </div>
                        <div class="flashcard-back text-center">
                            <h3 class="mb-4">${student.name}</h3>
                            <button class="btn btn-success btn-circle-xl" 
                                    onclick="removeCard(event, 'student-card-${index}')">
                                <i class="bi bi-check-lg text-white"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        container.innerHTML += cardHTML;
    });
}

function removeCard(event, cardId) {
    event.stopPropagation();
    const card = document.getElementById(cardId);
    card.style.transition = "all 0.4s ease";
    card.style.transform = "scale(0)";
    card.style.opacity = "0";
    setTimeout(() => {
        card.remove();
        updateCounter();
    }, 400);
}

function updateCounter() {
    const remaining = document.querySelectorAll('.flashcard-wrapper').length;
    const total = currentStudentList.length;
    const counterEl = document.getElementById('card-counter');
    const resetBtn = document.getElementById('reset-cards');
    
    if (remaining > 0) {
        counterEl.innerText = `${remaining} / ${total} Students Left`;
        resetBtn.classList.remove('d-none');
    } else {
        counterEl.innerHTML = `<span class="text-success"><i class="bi bi-trophy-fill"></i> All Done!</span>`;
        // Hide shuffle and reset when done to keep it clean, 
        // or keep reset visible if you want them to restart immediately
        document.getElementById('shuffle-cards').classList.add('d-none');
        document.getElementById('load-from-step2').classList.remove('d-none');
        document.getElementById('load-from-step2').innerText = "Restart Practice";
    }
}
// --- HELPERS ---

function sanitizeName(name) {
    return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function updateDisplay() {
    const jsonStr = JSON.stringify(extractedData, null, 4);
    const display = document.getElementById('json-display');
    display.textContent = jsonStr;
    if (window.Prism) Prism.highlightElement(display);
}

// Download Handlers
document.getElementById('download-json').addEventListener('click', () => {
    const jsonContent = JSON.stringify(extractedData, null, 4);
    const blob = new Blob([jsonContent], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `student-data.json`;
    link.click();
});

document.getElementById('download-images').addEventListener('click', async () => {
    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = "student-photos.zip";
    link.click();
});

// Handle Reset Button Click
document.getElementById('reset-cards').addEventListener('click', function() {
    if (currentStudentList.length === 0) return;

    // We simply re-render the current list as it was
    renderFlashcards(currentStudentList);
    updateCounter();
    
    // Smooth scroll back to the top of the cards if they've scrolled down
    document.getElementById('flashcard-container').scrollIntoView({ behavior: 'smooth' });
});

// Update the 'load-from-step2' click handler to show the reset button
// Find this section in your current code and add the reset-cards line:
document.getElementById('load-from-step2').addEventListener('click', function() {
    // ... (existing code)
    document.getElementById('shuffle-cards').classList.remove('d-none');
    document.getElementById('reset-cards').classList.remove('d-none'); // Add this line
    document.getElementById('card-counter').classList.remove('d-none');
    // ...
});

function resetAppState() {
    // 1. Clear Data Variables
    extractedData = [];
    imageMemoryMap = {};
    currentStudentList = [];
    zip = new JSZip();

    // 2. Reset Step 2 UI (Extraction)
    document.getElementById('status').innerText = "";
    const jsonDisplay = document.getElementById('json-display');
    jsonDisplay.textContent = "[]";
    if (window.Prism) Prism.highlightElement(jsonDisplay);
    
    // Hide preview if it was open
    $("#preview").addClass("d-none");
    $("#view-preview").removeClass("d-none");
    $("#hide-preview").addClass("d-none");

    // 3. Reset Step 3 UI (Flashcards)
    document.getElementById('flashcard-container').innerHTML = '';
    
    // Reset Buttons
    const loadBtn = document.getElementById('load-from-step2');
    loadBtn.classList.remove('d-none');
    loadBtn.innerText = "Generate Flashcards";
    
    document.getElementById('shuffle-cards').classList.add('d-none');
    document.getElementById('reset-cards').classList.add('d-none');
    
    const counter = document.getElementById('card-counter');
    counter.innerText = "";
    counter.classList.add('d-none');
}

// clipboard button ---------------------
new Clipboard('.copier');

$("#preview-json").on("click", function () {
    $("#preview").toggleClass("d-none");
    $("#view-preview").toggleClass("d-none");
    $("#hide-preview").toggleClass("d-none");
});

// write year to footer
 const thisYear = new Date().getFullYear();
      $("#footer-year").text(thisYear);