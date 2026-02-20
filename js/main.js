// Configuration
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let extractedData = [];    // The main data array
let imageMemoryMap = {};   // Stores filename -> BlobURL for the flashcards
let currentStudentList = []; // The "working copy" for the flashcard deck
let zip = new JSZip();

// --- STEP 2: PDF EXTRACTION LOGIC ---

document.getElementById('pdf-upload').addEventListener('change', async (e) => {
    // 1. Reset everything before starting a new upload
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

                let nameFont = "";
                let firstNameY = -1;
                
                // Step A: Dynamically figure out the font and starting Y-coordinate of the names
                for (let j = 0; j < items.length; j++) {
                    const text = items[j].str.trim();
                    if (text.toLowerCase().includes("classification")) {
                        for (let k = j - 1; k >= 0; k--) {
                            if (items[k].str.trim().length > 0) {
                                nameFont = items[k].fontName; 
                                firstNameY = items[k].transform[5]; 
                                break;
                            }
                        }
                        break; 
                    }
                }

                let currentNameParts = [];
                let pageNames = [];

                // Step B: Filter items to isolate names and ignore headers/details
                for (let j = 0; j < items.length; j++) {
                    const item = items[j];
                    const text = item.str.trim();
                    const itemY = item.transform[5];

                    if (!text) continue;

                    // Ignore the header box
                    if (firstNameY !== -1 && itemY > firstNameY + 5) continue; 

                    // Group by student
                    if (text.toLowerCase().includes("classification")) {
                        if (currentNameParts.length > 0) {
                            pageNames.push(currentNameParts.join(" ").trim());
                            currentNameParts = [];
                        }
                    } 
                    // Capture the bolded names
                    else if (item.fontName === nameFont && text.length > 1) {
                        currentNameParts.push(text);
                    }
                }
                
                // Catch the very last name on the page
                if (currentNameParts.length > 0) {
                    pageNames.push(currentNameParts.join(" ").trim());
                }

                // Step C: Image Extraction
                const ops = await page.getOperatorList();
                let imgKeys = [];
                
                // 1. Gather all image IDs on the page
                for (let j = 0; j < ops.fnArray.length; j++) {
                    if (ops.fnArray[j] === pdfjsLib.OPS.paintImageXObject) {
                        imgKeys.push(ops.argsArray[j][0]);
                    }
                }

                let validImages = [];
                // 2. Filter out tiny icons and wide banners
                for (let j = 0; j < imgKeys.length; j++) {
                    try {
                        const image = await page.objs.get(imgKeys[j]);
                        if (image.width < 20 || image.height < 20) continue; // Skip tiny images
                        if (image.width > image.height * 1.5) continue;      // Skip wide headers/logos
                        
                        validImages.push(imgKeys[j]);
                    } catch (e) { /* ignore fetching errors */ }
                }

                let finalImageKeys = [];
                // 3. THE MASK FIX: 
                // Since taking index 0 gave us masks, the sequence is [Mask, Photo, Mask, Photo].
                // We start our loop at 'j = 1' to grab the actual photos!
                if (validImages.length >= pageNames.length * 2) {
                    for (let j = 1; j < validImages.length; j += 2) {
                        finalImageKeys.push(validImages[j]);
                        if (finalImageKeys.length === pageNames.length) break; 
                    }
                } else {
                    // Fallback just in case the PDF didn't double-layer them
                    finalImageKeys = validImages.slice(0, pageNames.length);
                }

                // 4. Process the finalized images and pair them with names
                for (let j = 0; j < finalImageKeys.length; j++) {
                    if (!pageNames[j]) break; // Safety break if we run out of names

                    const imgKey = finalImageKeys[j];
                    const cleanName = pageNames[j];
                    const fileName = sanitizeName(cleanName) + ".jpg";

                    try {
                        const image = await page.objs.get(imgKey);
                        const canvas = document.createElement('canvas');
                        canvas.width = image.width;
                        canvas.height = image.height;
                        const ctx = canvas.getContext('2d');

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
                        zip.file(fileName, blob);
                        
                        const blobUrl = URL.createObjectURL(blob);
                        imageMemoryMap[fileName] = blobUrl;

                        extractedData.push({
                            name: cleanName,
                            headshot: fileName
                        });
                    } catch (e) { console.error("Img error:", e); }
                }
            }

            updateDisplay();
            status.innerHTML = `<span class="text-success fw-bold"><i class="bi bi-check-circle me-2"></i> Success! Extracted ${extractedData.length} students.</span>`;

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
    document.getElementById('reset-cards').classList.remove('d-none');
    document.getElementById('card-counter').classList.remove('d-none');
    document.getElementById('download-attendance').classList.remove('d-none');
    
    renderFlashcards(currentStudentList);
    updateCounter();
});

document.getElementById('shuffle-cards').addEventListener('click', function() {
    const visibleNames = Array.from(document.querySelectorAll('.flashcard-wrapper h3'))
                             .map(h3 => h3.innerText);
    
    const remainingStudents = currentStudentList.filter(student => 
        visibleNames.includes(student.name)
    );

    if (remainingStudents.length === 0) return;

    const shuffled = shuffleArray(remainingStudents);
    renderFlashcards(shuffled);
    
    updateCounter();
});

document.getElementById('reset-cards').addEventListener('click', function() {
    if (currentStudentList.length === 0) return;
    renderFlashcards(currentStudentList);
    updateCounter();
    document.getElementById('flashcard-container').scrollIntoView({ behavior: 'smooth' });
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
        counterEl.innerText = `${remaining} / ${total} Students`;
        resetBtn.classList.remove('d-none');
    } else {
        counterEl.innerHTML = `<span class="text-success me-4"><i class="bi bi-trophy-fill me-2"></i> Nice Work!</span>`;
        document.getElementById('shuffle-cards').classList.add('d-none');
        document.getElementById('load-from-step2').classList.remove('d-none');
        document.getElementById('load-from-step2').innerHTML = "<i class='bi bi-arrow-repeat text-nowrap p-2 me-1'></i>Restart";
        document.getElementById('download-attendance').classList.add('d-none');
    }
}

// --- ATTENDANCE DOWNLOADER ---

function getTimestamp() {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

document.getElementById('download-attendance').addEventListener('click', function() {
    const remainingCards = document.querySelectorAll('.flashcard-wrapper h3');
    let absentList = [];
    remainingCards.forEach(cardTitle => absentList.push(cardTitle.innerText));

    if (absentList.length === 0) {
        alert("Everyone has been marked present!");
        return;
    }

    const blob = new Blob([absentList.join('\n')], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `attendance-${getTimestamp()}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
});

// --- HELPERS & UI STATE ---

function resetAppState() {
    extractedData = [];
    imageMemoryMap = {};
    currentStudentList = [];
    zip = new JSZip();

    document.getElementById('status').innerText = "";
    document.getElementById('json-display').textContent = "[]";
    document.getElementById('download-the-files').classList.add('d-none');
    document.getElementById('flashcard-container').innerHTML = '';
    
    const loadBtn = document.getElementById('load-from-step2');
    loadBtn.classList.remove('d-none');
    loadBtn.innerHTML = "<i class='bi bi-person-badge me-2'></i>Generate Student Cards";
    
    document.getElementById('shuffle-cards').classList.add('d-none');
    document.getElementById('reset-cards').classList.add('d-none');
    document.getElementById('download-attendance').classList.add('d-none');
    
    const counter = document.getElementById('card-counter');
    counter.innerText = "";
    counter.classList.add('d-none');
}

function updateDisplay() {
    const jsonStr = JSON.stringify(extractedData, null, 4);
    const display = document.getElementById('json-display');
    display.textContent = jsonStr;
    if (window.Prism) Prism.highlightElement(display);

    document.getElementById('download-the-files').classList.remove('d-none');
}

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

document.getElementById('download-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(extractedData, null, 4)], { type: 'application/json' });
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

// --- CUSTOM SNIPPETS & JQUERY ---

// Reset the entire page
$("#start-over").on("click", function () {
    if(confirm("This will clear all data. Are you sure?")) {
        window.location.reload(true);
    }
});

// Clipboard Initialization
new Clipboard('.copier');

// Preview Toggle
$("#preview-json").on("click", function () {
    $("#preview").toggleClass("d-none");
    $("#view-preview").toggleClass("d-none");
    $("#hide-preview").toggleClass("d-none");
});

// Footer Year
$("#footer-year").text(new Date().getFullYear());